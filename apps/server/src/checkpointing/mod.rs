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
