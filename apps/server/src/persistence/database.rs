use std::{
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use rusqlite::{Connection, MAIN_DB, OpenFlags};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

const DATABASE_QUEUE_CAPACITY: usize = 64;
const PREPARED_STATEMENT_CACHE_CAPACITY: usize = 64;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WAL_AUTOCHECKPOINT_PAGES: u32 = 1_000;
const JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

type DatabaseJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("failed to spawn the SQLite worker thread")]
    SpawnWorker(#[source] std::io::Error),
    #[error("failed to create SQLite database directory {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open SQLite database {path}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
    #[error("failed to configure SQLite database")]
    Configure(#[source] rusqlite::Error),
    #[error("SQLite operation failed")]
    Sql(#[from] rusqlite::Error),
    #[error("SQLite integrity check failed: {0}")]
    Corrupt(String),
    #[error("the SQLite worker is no longer available")]
    WorkerUnavailable,
    #[error("the SQLite worker dropped an operation response")]
    ResponseDropped,
}

pub type Result<T> = std::result::Result<T, PersistenceError>;

#[derive(Clone, Debug)]
pub struct Database {
    sender: mpsc::Sender<DatabaseJob>,
}

impl Database {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(Some(path.as_ref().to_path_buf())).await
    }

    pub async fn open_in_memory() -> Result<Self> {
        Self::open_inner(None).await
    }

    async fn open_inner(path: Option<PathBuf>) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<DatabaseJob>(DATABASE_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = oneshot::channel();
        thread::Builder::new()
            .name("t4code-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(path.as_deref());
                match connection {
                    Ok(mut connection) => {
                        if ready_sender.send(Ok(())).is_err() {
                            return;
                        }
                        while let Some(job) = receiver.blocking_recv() {
                            job(&mut connection);
                        }
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                    }
                }
            })
            .map_err(PersistenceError::SpawnWorker)?;

        ready_receiver
            .await
            .map_err(|_| PersistenceError::WorkerUnavailable)??;
        Ok(Self { sender })
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let (response_sender, response_receiver) = oneshot::channel();
        let permit = self
            .sender
            .reserve()
            .await
            .map_err(|_| PersistenceError::WorkerUnavailable)?;
        permit.send(Box::new(move |connection| {
            let _ = response_sender.send(operation(connection));
        }));
        response_receiver
            .await
            .map_err(|_| PersistenceError::ResponseDropped)?
    }

    pub async fn backup_to(&self, destination: impl AsRef<Path>) -> Result<()> {
        let destination = destination.as_ref().to_path_buf();
        self.call(move |connection| {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|source| {
                    PersistenceError::CreateDirectory {
                        path: parent.to_path_buf(),
                        source,
                    }
                })?;
            }
            connection.backup(MAIN_DB, destination, None)?;
            Ok(())
        })
        .await
    }

    pub async fn quick_check(&self) -> Result<()> {
        self.call(|connection| {
            let result =
                connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?;
            if result == "ok" {
                Ok(())
            } else {
                Err(PersistenceError::Corrupt(result))
            }
        })
        .await
    }
}

fn open_connection(path: Option<&Path>) -> Result<Connection> {
    let connection = match path {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|source| {
                    PersistenceError::CreateDirectory {
                        path: parent.to_path_buf(),
                        source,
                    }
                })?;
            }
            Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|source| PersistenceError::Open {
                path: path.to_path_buf(),
                source,
            })?
        }
        None => Connection::open_in_memory().map_err(|source| PersistenceError::Open {
            path: PathBuf::from(":memory:"),
            source,
        })?,
    };

    connection.set_prepared_statement_cache_capacity(PREPARED_STATEMENT_CACHE_CAPACITY);
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(PersistenceError::Configure)?;
    if path.is_some() {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(PersistenceError::Configure)?;
        connection
            .pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
            .map_err(PersistenceError::Configure)?;
        connection
            .pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT_BYTES)
            .map_err(PersistenceError::Configure)?;
    }
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn serializes_concurrent_writers_and_enables_durable_pragmas() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let database = Database::open(&database_path)
            .await
            .expect("database opens");
        database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);\
                     INSERT INTO counters (id, value) VALUES (1, 0);",
                )?;
                Ok(())
            })
            .await
            .expect("fixture schema");

        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let database = database.clone();
            tasks.spawn(async move {
                database
                    .call(|connection| {
                        connection
                            .execute("UPDATE counters SET value = value + 1 WHERE id = 1", [])?;
                        Ok(())
                    })
                    .await
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.expect("writer task").expect("writer succeeds");
        }

        let (value, foreign_keys, journal_mode, synchronous) = database
            .call(|connection| {
                Ok((
                    connection.query_row("SELECT value FROM counters WHERE id = 1", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?,
                    connection
                        .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?,
                    connection.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?,
                ))
            })
            .await
            .expect("database snapshot");
        assert_eq!(value, 32);
        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite durability must remain FULL");
    }

    #[tokio::test]
    async fn rejects_corrupt_database_files_without_replacing_them() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        std::fs::write(&database_path, b"not a sqlite database").expect("corrupt fixture");

        let error = Database::open(&database_path)
            .await
            .expect_err("corrupt database must fail");

        assert!(matches!(
            error,
            PersistenceError::Configure(_) | PersistenceError::Open { .. }
        ));
        assert_eq!(
            std::fs::read(&database_path).expect("corrupt fixture remains"),
            b"not a sqlite database"
        );
    }

    #[tokio::test]
    async fn backup_and_reopen_preserve_committed_data() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let backup_path = temp.path().join("backups/state.sqlite");
        let database = Database::open(&database_path)
            .await
            .expect("database opens");
        database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE durable (id TEXT PRIMARY KEY, value TEXT NOT NULL);\
                     INSERT INTO durable (id, value) VALUES ('fixture', 'preserved');",
                )?;
                Ok(())
            })
            .await
            .expect("durable fixture");
        database.quick_check().await.expect("source is healthy");
        database
            .backup_to(&backup_path)
            .await
            .expect("online backup");
        drop(database);

        let reopened = Database::open(&backup_path).await.expect("backup reopens");
        let value = reopened
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT value FROM durable WHERE id = 'fixture'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .await
            .expect("backup query");
        assert_eq!(value, "preserved");
    }
}
