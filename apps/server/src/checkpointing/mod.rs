use rusqlite::{Transaction, params};
use serde_json::Value;

use crate::persistence::PersistenceError;

pub fn upsert_diff_blob(
    transaction: &Transaction<'_>,
    thread_id: &str,
    from_turn_count: i64,
    to_turn_count: i64,
    diff: &str,
    created_at: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (thread_id, from_turn_count, to_turn_count) DO UPDATE SET \
           diff = excluded.diff, created_at = excluded.created_at",
        params![thread_id, from_turn_count, to_turn_count, diff, created_at],
    )?;
    Ok(())
}

pub fn empty_files() -> Value {
    Value::Array(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::run_migrations;

    #[test]
    fn checkpoint_helpers_upsert_diff_rows_and_return_empty_file_lists() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("database");
        run_migrations(&mut connection, None).expect("migrations");
        let transaction = connection.transaction().expect("transaction");
        upsert_diff_blob(
            &transaction,
            "thread",
            1,
            2,
            "diff --git a/file b/file",
            "2026-01-01T00:00:00Z",
        )
        .expect("checkpoint diff should upsert");
        upsert_diff_blob(
            &transaction,
            "thread",
            1,
            2,
            "updated diff",
            "2026-01-02T00:00:00Z",
        )
        .expect("checkpoint diff should replace");
        let diff: String = transaction
            .query_row(
                "SELECT diff FROM checkpoint_diff_blobs WHERE thread_id = 'thread'",
                [],
                |row| row.get(0),
            )
            .expect("checkpoint diff row");
        assert_eq!(diff, "updated diff");
        assert_eq!(empty_files(), Value::Array(Vec::new()));
    }
}
