use rusqlite::{
    Connection, ErrorCode, OptionalExtension, Result, Transaction, params_from_iter, types::Value,
};

const MIGRATIONS_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)
"#;

type MigrationFn = for<'connection> fn(&Transaction<'connection>) -> Result<()>;

#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub id: u32,
    pub name: &'static str,
    apply: MigrationFn,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration::new(1, "OrchestrationEvents", migration_001),
    Migration::new(2, "OrchestrationCommandReceipts", migration_002),
    Migration::new(3, "CheckpointDiffBlobs", migration_003),
    Migration::new(4, "ProviderSessionRuntime", migration_004),
    Migration::new(5, "Projections", migration_005),
    Migration::new(
        6,
        "ProjectionThreadSessionRuntimeModeColumns",
        migration_006,
    ),
    Migration::new(7, "ProjectionThreadMessageAttachments", migration_007),
    Migration::new(8, "ProjectionThreadActivitySequence", migration_008),
    Migration::new(9, "ProviderSessionRuntimeMode", migration_009),
    Migration::new(10, "ProjectionThreadsRuntimeMode", migration_010),
    Migration::new(11, "OrchestrationThreadCreatedRuntimeMode", migration_011),
    Migration::new(12, "ProjectionThreadsInteractionMode", migration_012),
    Migration::new(13, "ProjectionThreadProposedPlans", migration_013),
    Migration::new(
        14,
        "ProjectionThreadProposedPlanImplementation",
        migration_014,
    ),
    Migration::new(15, "ProjectionTurnsSourceProposedPlan", migration_015),
    Migration::new(16, "CanonicalizeModelSelections", migration_016),
    Migration::new(17, "ProjectionThreadsArchivedAt", migration_017),
    Migration::new(18, "ProjectionThreadsArchivedAtIndex", migration_018),
    Migration::new(19, "ProjectionSnapshotLookupIndexes", migration_019),
    Migration::new(20, "AuthAccessManagement", migration_020),
    Migration::new(21, "AuthSessionClientMetadata", migration_021),
    Migration::new(22, "AuthSessionLastConnectedAt", migration_022),
    Migration::new(23, "ProjectionThreadShellSummary", migration_023),
    Migration::new(24, "BackfillProjectionThreadShellSummary", migration_024),
    Migration::new(
        25,
        "CleanupInvalidProjectionPendingApprovals",
        migration_025,
    ),
    Migration::new(26, "CanonicalizeModelSelectionOptions", migration_026),
    Migration::new(27, "ProviderSessionRuntimeInstanceId", migration_027),
    Migration::new(28, "ProjectionThreadSessionInstanceId", migration_028),
    Migration::new(29, "ProjectionThreadDetailOrderingIndexes", migration_029),
    Migration::new(30, "ProjectionThreadShellArchiveIndexes", migration_030),
    Migration::new(31, "AuthAuthorizationScopes", migration_031),
    Migration::new(32, "AuthPairingProofKeyThumbprint", migration_032),
    Migration::new(33, "ProjectionThreadsKind", migration_033),
];

impl Migration {
    const fn new(id: u32, name: &'static str, apply: MigrationFn) -> Self {
        Self { id, name, apply }
    }
}

/// Runs pending migrations through `through_id`, or all migrations when it is `None`.
///
/// The ledger shape and ordering match Effect's SQL migrator. Pending ledger rows and
/// migration bodies share one transaction, so a failed body leaves neither schema nor
/// ledger changes behind.
pub fn run_migrations(
    connection: &mut Connection,
    through_id: Option<u32>,
) -> Result<Vec<Migration>> {
    connection.execute_batch(MIGRATIONS_TABLE_SQL)?;

    let transaction = connection.transaction()?;
    let latest_id = transaction
        .query_row(
            "SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let required = MIGRATIONS
        .iter()
        .copied()
        .filter(|migration| {
            i64::from(migration.id) > latest_id
                && through_id.is_none_or(|through_id| migration.id <= through_id)
        })
        .collect::<Vec<_>>();

    if required.is_empty() {
        transaction.commit()?;
        return Ok(required);
    }

    if let Err(error) = insert_ledger_rows(&transaction, &required) {
        if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
            transaction.rollback()?;
            return Ok(Vec::new());
        }
        return Err(error);
    }

    for migration in &required {
        (migration.apply)(&transaction)?;
    }

    transaction.commit()?;
    Ok(required)
}

fn insert_ledger_rows(transaction: &Transaction<'_>, migrations: &[Migration]) -> Result<()> {
    let placeholders = std::iter::repeat_n("(?, ?)", migrations.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("INSERT INTO effect_sql_migrations (migration_id, name) VALUES {placeholders}");
    let values = migrations
        .iter()
        .flat_map(|migration| {
            [
                Value::Integer(i64::from(migration.id)),
                Value::Text(migration.name.to_owned()),
            ]
        })
        .collect::<Vec<_>>();
    transaction.execute(&sql, params_from_iter(values))?;
    Ok(())
}

fn table_has_column(transaction: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migration_001(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS orchestration_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          aggregate_kind TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          stream_version INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT,
          causation_event_id TEXT,
          correlation_id TEXT,
          actor_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_stream_version
        ON orchestration_events(aggregate_kind, stream_id, stream_version);

        CREATE INDEX IF NOT EXISTS idx_orch_events_stream_sequence
        ON orchestration_events(aggregate_kind, stream_id, sequence);

        CREATE INDEX IF NOT EXISTS idx_orch_events_command_id
        ON orchestration_events(command_id);

        CREATE INDEX IF NOT EXISTS idx_orch_events_correlation_id
        ON orchestration_events(correlation_id);
        "#,
    )
}

fn migration_002(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
          command_id TEXT PRIMARY KEY,
          aggregate_kind TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          result_sequence INTEGER NOT NULL,
          status TEXT NOT NULL,
          error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_aggregate
        ON orchestration_command_receipts(aggregate_kind, aggregate_id);

        CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_sequence
        ON orchestration_command_receipts(result_sequence);
        "#,
    )
}

fn migration_003(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS checkpoint_diff_blobs (
          thread_id TEXT NOT NULL,
          from_turn_count INTEGER NOT NULL,
          to_turn_count INTEGER NOT NULL,
          diff TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, from_turn_count, to_turn_count)
        );

        CREATE INDEX IF NOT EXISTS idx_checkpoint_diff_blobs_thread_to_turn
        ON checkpoint_diff_blobs(thread_id, to_turn_count);
        "#,
    )
}

fn migration_004(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS provider_session_runtime (
          thread_id TEXT PRIMARY KEY,
          provider_name TEXT NOT NULL,
          adapter_key TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          status TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resume_cursor_json TEXT,
          runtime_payload_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status
        ON provider_session_runtime(status);

        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider
        ON provider_session_runtime(provider_name);
        "#,
    )
}

fn migration_005(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          default_model TEXT,
          scripts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          model TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_thread_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          is_streaming INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          tone TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          provider_name TEXT,
          provider_session_id TEXT,
          provider_thread_id TEXT,
          active_turn_id TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          pending_message_id TEXT,
          assistant_message_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          checkpoint_turn_count INTEGER,
          checkpoint_ref TEXT,
          checkpoint_status TEXT,
          checkpoint_files_json TEXT NOT NULL,
          UNIQUE (thread_id, turn_id),
          UNIQUE (thread_id, checkpoint_turn_count)
        );

        CREATE TABLE IF NOT EXISTS projection_pending_approvals (
          request_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_state (
          projector TEXT PRIMARY KEY,
          last_applied_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
        ON projection_projects(updated_at);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
        ON projection_threads(project_id);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created
        ON projection_thread_messages(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_created
        ON projection_thread_activities(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_session
        ON projection_thread_sessions(provider_session_id);

        CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_requested
        ON projection_turns(thread_id, requested_at);

        CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_checkpoint_completed
        ON projection_turns(thread_id, checkpoint_turn_count, completed_at);

        CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status
        ON projection_pending_approvals(thread_id, status);
        "#,
    )
}

fn migration_006(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_sessions
        ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access';

        UPDATE projection_thread_sessions
        SET runtime_mode = 'full-access'
        WHERE runtime_mode IS NULL;
        "#,
    )
}

fn migration_007(transaction: &Transaction<'_>) -> Result<()> {
    transaction
        .execute_batch("ALTER TABLE projection_thread_messages ADD COLUMN attachments_json TEXT")
}

fn migration_008(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_activities ADD COLUMN sequence INTEGER;

        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
        ON projection_thread_activities(thread_id, sequence);
        "#,
    )
}

fn migration_009(_transaction: &Transaction<'_>) -> Result<()> {
    Ok(())
}

fn migration_010(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access';

        UPDATE projection_threads
        SET runtime_mode = 'full-access'
        WHERE runtime_mode IS NULL;
        "#,
    )
}

fn migration_011(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access')
        WHERE event_type = 'thread.created'
          AND json_type(payload_json, '$.runtimeMode') IS NULL;
        "#,
    )
}

fn migration_012(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default';
        "#,
    )
}

fn migration_013(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
          plan_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          plan_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created
        ON projection_thread_proposed_plans(thread_id, created_at);
        "#,
    )
}

fn migration_014(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_proposed_plans ADD COLUMN implemented_at TEXT;
        ALTER TABLE projection_thread_proposed_plans ADD COLUMN implementation_thread_id TEXT;
        "#,
    )
}

fn migration_015(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_turns ADD COLUMN source_proposed_plan_thread_id TEXT;
        ALTER TABLE projection_turns ADD COLUMN source_proposed_plan_id TEXT;
        "#,
    )
}

fn migration_016(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_projects
        ADD COLUMN default_model_selection_json TEXT;

        UPDATE projection_projects
        SET default_model_selection_json = CASE
          WHEN default_model IS NULL THEN NULL
          ELSE json_object(
            'provider',
            CASE
              WHEN lower(default_model) LIKE '%claude%' THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'model',
            default_model
          )
        END
        WHERE default_model_selection_json IS NULL;

        ALTER TABLE projection_threads
        ADD COLUMN model_selection_json TEXT;

        UPDATE projection_threads
        SET model_selection_json = json_object(
          'provider',
          COALESCE(
            (
              SELECT provider_name
              FROM projection_thread_sessions
              WHERE projection_thread_sessions.thread_id = projection_threads.thread_id
            ),
            CASE
              WHEN lower(model) LIKE '%claude%' THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'codex'
          ),
          'model',
          model
        )
        WHERE model_selection_json IS NULL;

        ALTER TABLE projection_projects
        DROP COLUMN default_model;

        ALTER TABLE projection_threads
        DROP COLUMN model;

        UPDATE orchestration_events
        SET payload_json = CASE
          WHEN json_type(payload_json, '$.defaultModel') = 'null' THEN json_remove(
            json_set(payload_json, '$.defaultModelSelection', json('null')),
            '$.defaultProvider',
            '$.defaultModel',
            '$.defaultModelOptions'
          )
          ELSE json_remove(
            json_set(
              payload_json,
              '$.defaultModelSelection',
              json_patch(
                json_object(
                  'provider',
                  CASE
                    WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                    THEN json_extract(payload_json, '$.defaultProvider')
                    WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                    THEN 'claudeAgent'
                    ELSE 'codex'
                  END,
                  'model',
                  json_extract(payload_json, '$.defaultModel')
                ),
                CASE
                  WHEN json_type(payload_json, '$.defaultModelOptions') IS NULL THEN '{}'
                  WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                    OR json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                  THEN CASE
                    WHEN (
                      CASE
                        WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                        THEN json_extract(payload_json, '$.defaultProvider')
                        WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                        THEN 'claudeAgent'
                        ELSE 'codex'
                      END
                    ) = 'claudeAgent'
                    THEN CASE
                      WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                      )
                      WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                      )
                      ELSE '{}'
                    END
                    ELSE CASE
                      WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                      )
                      WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                      )
                      ELSE '{}'
                    END
                  END
                  ELSE json_object(
                    'options',
                    json(json_extract(payload_json, '$.defaultModelOptions'))
                  )
                END
              )
            ),
            '$.defaultProvider',
            '$.defaultModel',
            '$.defaultModelOptions'
          )
        END
        WHERE event_type IN ('project.created', 'project.meta-updated')
          AND json_type(payload_json, '$.defaultModelSelection') IS NULL
          AND json_type(payload_json, '$.defaultModel') IS NOT NULL;

        UPDATE orchestration_events
        SET payload_json = json_remove(
          json_set(
            payload_json,
            '$.modelSelection',
            json_patch(
              json_object(
                'provider',
                CASE
                  WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                  THEN json_extract(payload_json, '$.provider')
                  WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                  THEN 'claudeAgent'
                  ELSE 'codex'
                END,
                'model',
                json_extract(payload_json, '$.model')
              ),
              CASE
                WHEN json_type(payload_json, '$.modelOptions') IS NULL THEN '{}'
                WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                  OR json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                THEN CASE
                  WHEN (
                    CASE
                      WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                      THEN json_extract(payload_json, '$.provider')
                      WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                      THEN 'claudeAgent'
                      ELSE 'codex'
                    END
                  ) = 'claudeAgent'
                  THEN CASE
                    WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                    )
                    WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.codex'))
                    )
                    ELSE '{}'
                  END
                  ELSE CASE
                    WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.codex'))
                    )
                    WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                    )
                    ELSE '{}'
                  END
                END
                ELSE json_object('options', json(json_extract(payload_json, '$.modelOptions')))
              END
            )
          ),
          '$.provider',
          '$.model',
          '$.modelOptions'
        )
        WHERE event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
          AND json_type(payload_json, '$.modelSelection') IS NULL
          AND json_type(payload_json, '$.model') IS NOT NULL;

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.modelSelection',
          json(json_object('provider', 'codex', 'model', 'gpt-5.4'))
        )
        WHERE event_type = 'thread.created'
          AND json_type(payload_json, '$.modelSelection') IS NULL
          AND json_type(payload_json, '$.model') IS NULL;
        "#,
    )
}

fn migration_017(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "projection_threads", "archived_at")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE projection_threads ADD COLUMN archived_at TEXT")
}

fn migration_018(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
        ON projection_threads(project_id, archived_at);
        "#,
    )
}

fn migration_019(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_projects_workspace_root_deleted_at
        ON projection_projects(workspace_root, deleted_at);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
        ON projection_threads(project_id, deleted_at, created_at);
        "#,
    )
}

fn migration_020(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          role TEXT NOT NULL,
          subject TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
        ON auth_pairing_links(revoked_at, consumed_at, expires_at);

        CREATE TABLE IF NOT EXISTS auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          role TEXT NOT NULL,
          method TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
        ON auth_sessions(revoked_at, expires_at, issued_at);
        "#,
    )
}

fn migration_021(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(transaction, "auth_pairing_links", "label")? {
        transaction.execute_batch("ALTER TABLE auth_pairing_links ADD COLUMN label TEXT")?;
    }

    for (column, definition) in [
        ("client_label", "client_label TEXT"),
        ("client_ip_address", "client_ip_address TEXT"),
        ("client_user_agent", "client_user_agent TEXT"),
        (
            "client_device_type",
            "client_device_type TEXT NOT NULL DEFAULT 'unknown'",
        ),
        ("client_os", "client_os TEXT"),
        ("client_browser", "client_browser TEXT"),
    ] {
        if !table_has_column(transaction, "auth_sessions", column)? {
            transaction.execute_batch(&format!(
                "ALTER TABLE auth_sessions ADD COLUMN {definition}"
            ))?;
        }
    }

    Ok(())
}

fn migration_022(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "auth_sessions", "last_connected_at")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE auth_sessions ADD COLUMN last_connected_at TEXT")
}

fn migration_023(transaction: &Transaction<'_>) -> Result<()> {
    let _ = transaction
        .execute_batch("ALTER TABLE projection_threads ADD COLUMN latest_user_message_at TEXT");
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0",
    );
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0",
    );
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0",
    );
    Ok(())
}

fn migration_024(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        INSERT OR IGNORE INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        SELECT
          requested.request_id,
          requested.thread_id,
          requested.turn_id,
          'pending',
          NULL,
          requested.created_at,
          NULL
        FROM (
          SELECT
            json_extract(payload_json, '$.requestId') AS request_id,
            thread_id,
            turn_id,
            created_at,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.requestId')
              ORDER BY created_at ASC, activity_id ASC
            ) AS row_number
          FROM projection_thread_activities
          WHERE kind = 'approval.requested'
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
        ) AS requested
        WHERE requested.row_number = 1;

        WITH latest_resolutions AS (
          SELECT
            resolved.request_id,
            resolved.resolved_at,
            resolved.decision
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              created_at AS resolved_at,
              CASE
                WHEN json_extract(payload_json, '$.decision') IN (
                  'accept',
                  'acceptForSession',
                  'decline',
                  'cancel'
                )
                THEN json_extract(payload_json, '$.decision')
                ELSE NULL
              END AS decision,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY created_at DESC, activity_id DESC
              ) AS row_number
            FROM projection_thread_activities
            WHERE kind = 'approval.resolved'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
          ) AS resolved
          WHERE resolved.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = (
            SELECT latest_resolutions.decision
            FROM latest_resolutions
            WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
          ),
          resolved_at = (
            SELECT latest_resolutions.resolved_at
            FROM latest_resolutions
            WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
          )
        WHERE EXISTS (
          SELECT 1
          FROM latest_resolutions
          WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
        );

        WITH latest_response_events AS (
          SELECT
            response.request_id,
            response.resolved_at,
            response.decision
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              occurred_at AS resolved_at,
              CASE
                WHEN json_extract(payload_json, '$.decision') IN (
                  'accept',
                  'acceptForSession',
                  'decline',
                  'cancel'
                )
                THEN json_extract(payload_json, '$.decision')
                ELSE NULL
              END AS decision,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY occurred_at DESC, sequence DESC
              ) AS row_number
            FROM orchestration_events
            WHERE event_type = 'thread.approval-response-requested'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
          ) AS response
          WHERE response.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = (
            SELECT latest_response_events.decision
            FROM latest_response_events
            WHERE latest_response_events.request_id = projection_pending_approvals.request_id
          ),
          resolved_at = (
            SELECT latest_response_events.resolved_at
            FROM latest_response_events
            WHERE latest_response_events.request_id = projection_pending_approvals.request_id
          )
        WHERE EXISTS (
          SELECT 1
          FROM latest_response_events
          WHERE latest_response_events.request_id = projection_pending_approvals.request_id
        );

        WITH latest_stale_failures AS (
          SELECT
            failure.request_id,
            failure.resolved_at
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              created_at AS resolved_at,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY created_at DESC, activity_id DESC
              ) AS row_number
            FROM projection_thread_activities
            WHERE kind = 'provider.approval.respond.failed'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
              AND (
                lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%stale pending approval request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%unknown pending approval request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%unknown pending permission request%'
              )
          ) AS failure
          WHERE failure.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = NULL,
          resolved_at = (
            SELECT latest_stale_failures.resolved_at
            FROM latest_stale_failures
            WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
          )
        WHERE status = 'pending'
          AND EXISTS (
            SELECT 1
            FROM latest_stale_failures
            WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
          );

        UPDATE projection_threads
        SET
          latest_user_message_at = (
            SELECT MAX(message.created_at)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = projection_threads.thread_id
              AND message.role = 'user'
          ),
          pending_approval_count = COALESCE((
            SELECT COUNT(*)
            FROM projection_pending_approvals
            WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
              AND projection_pending_approvals.status = 'pending'
          ), 0),
          pending_user_input_count = COALESCE((
            WITH latest_user_input_states AS (
              SELECT
                latest.request_id,
                latest.kind,
                latest.detail
              FROM (
                SELECT
                  json_extract(activity.payload_json, '$.requestId') AS request_id,
                  activity.kind,
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(activity.payload_json, '$.requestId')
                    ORDER BY activity.created_at DESC, activity.activity_id DESC
                  ) AS row_number
                FROM projection_thread_activities AS activity
                WHERE activity.thread_id = projection_threads.thread_id
                  AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
                  AND activity.kind IN (
                    'user-input.requested',
                    'user-input.resolved',
                    'provider.user-input.respond.failed'
                  )
              ) AS latest
              WHERE latest.row_number = 1
            )
            SELECT COUNT(*)
            FROM latest_user_input_states
            WHERE latest_user_input_states.kind = 'user-input.requested'
              OR (
                latest_user_input_states.kind = 'provider.user-input.respond.failed'
                AND latest_user_input_states.detail NOT LIKE '%stale pending user-input request%'
                AND latest_user_input_states.detail NOT LIKE '%unknown pending user-input request%'
              )
          ), 0),
          has_actionable_proposed_plan = COALESCE((
            SELECT CASE
              WHEN projection_threads.latest_turn_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM projection_thread_proposed_plans AS latest_turn_plan_exists
                  WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
                    AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
                )
                THEN CASE
                  WHEN (
                    SELECT latest_turn_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_turn_plan
                    WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                      AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
                    ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              WHEN EXISTS (
                SELECT 1
                FROM projection_thread_proposed_plans AS any_plan
                WHERE any_plan.thread_id = projection_threads.thread_id
              )
                THEN CASE
                  WHEN (
                    SELECT latest_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_plan
                    WHERE latest_plan.thread_id = projection_threads.thread_id
                    ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              ELSE 0
            END
          ), 0);
        "#,
    )
}

fn migration_025(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        DELETE FROM projection_pending_approvals
        WHERE NOT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS activity
          WHERE activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId')
              = projection_pending_approvals.request_id
        );

        UPDATE projection_threads
        SET pending_approval_count = COALESCE((
          SELECT COUNT(*)
          FROM projection_pending_approvals
          WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
            AND projection_pending_approvals.status = 'pending'
        ), 0);
        "#,
    )
}

fn migration_026(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        UPDATE projection_threads
        SET model_selection_json = json_set(
          model_selection_json,
          '$.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(model_selection_json, '$.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE model_selection_json IS NOT NULL
          AND json_type(model_selection_json, '$.options') = 'object';

        UPDATE projection_projects
        SET default_model_selection_json = json_set(
          default_model_selection_json,
          '$.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(default_model_selection_json, '$.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE default_model_selection_json IS NOT NULL
          AND json_type(default_model_selection_json, '$.options') = 'object';

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.modelSelection.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(payload_json, '$.modelSelection.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE event_type IN (
          'thread.created',
          'thread.meta-updated',
          'thread.turn-start-requested'
        )
          AND json_type(payload_json, '$.modelSelection.options') = 'object';

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.defaultModelSelection.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(payload_json, '$.defaultModelSelection.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE event_type IN ('project.created', 'project.meta-updated')
          AND json_type(payload_json, '$.defaultModelSelection.options') = 'object';
        "#,
    )
}

fn migration_027(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(
        transaction,
        "provider_session_runtime",
        "provider_instance_id",
    )? {
        transaction.execute_batch(
            "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT",
        )?;
    }

    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_instance
        ON provider_session_runtime(provider_instance_id);
        "#,
    )
}

fn migration_028(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(
        transaction,
        "projection_thread_sessions",
        "provider_instance_id",
    )? {
        transaction.execute_batch(
            "ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT",
        )?;
    }

    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
        ON projection_thread_sessions(provider_instance_id);
        "#,
    )
}

fn migration_029(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence_created_id
        ON projection_thread_activities(thread_id, sequence, created_at, activity_id);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_id
        ON projection_thread_messages(thread_id, created_at, message_id);
        "#,
    )
}

fn migration_030(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active
        ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived
        ON projection_threads(deleted_at, archived_at, project_id, thread_id);
        "#,
    )
}

fn migration_031(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        DROP TABLE IF EXISTS auth_pairing_links;
        DROP TABLE IF EXISTS auth_sessions;

        CREATE TABLE auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          scopes TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX idx_auth_pairing_links_active
        ON auth_pairing_links(revoked_at, consumed_at, expires_at);

        CREATE TABLE auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          scopes TEXT NOT NULL,
          method TEXT NOT NULL,
          client_label TEXT,
          client_ip_address TEXT,
          client_user_agent TEXT,
          client_device_type TEXT NOT NULL DEFAULT 'unknown',
          client_os TEXT,
          client_browser TEXT,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_connected_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX idx_auth_sessions_active
        ON auth_sessions(revoked_at, expires_at, issued_at);
        "#,
    )
}

fn migration_032(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "auth_pairing_links", "proof_key_thumbprint")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE auth_pairing_links ADD COLUMN proof_key_thumbprint TEXT")
}

fn migration_033(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace';

        UPDATE projection_threads
        SET kind = 'workspace'
        WHERE kind IS NULL;
        "#,
    )
}

#[cfg(test)]
mod tests {
    use super::{MIGRATIONS, run_migrations};

    #[test]
    fn exposes_all_ordered_migration_metadata() {
        let ids = MIGRATIONS
            .iter()
            .map(|migration| migration.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, (1..=33).collect::<Vec<_>>());
        assert_eq!(MIGRATIONS[0].name, "OrchestrationEvents");
        assert_eq!(MIGRATIONS[32].name, "ProjectionThreadsKind");
    }

    #[test]
    fn migrates_fresh_database_and_resumes_from_a_cutoff() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;

        let first = run_migrations(&mut connection, Some(16))?;
        assert_eq!(first.len(), 16);
        assert_eq!(first[0].id, 1);
        assert_eq!(first[15].id, 16);

        let second = run_migrations(&mut connection, None)?;
        assert_eq!(second.len(), 17);
        assert_eq!(second[0].id, 17);
        assert_eq!(second[16].id, 33);

        let third = run_migrations(&mut connection, None)?;
        assert!(third.is_empty());

        let application_table_count = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' \
               AND name NOT IN ('effect_sql_migrations', 'sqlite_sequence')",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(application_table_count, 15);

        Ok(())
    }

    #[test]
    fn trusts_an_existing_current_effect_ledger_without_rebuilding_data() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        connection.execute_batch(
            "CREATE TABLE effect_sql_migrations (\
               migration_id integer PRIMARY KEY NOT NULL,\
               created_at datetime NOT NULL DEFAULT current_timestamp,\
               name VARCHAR(255) NOT NULL\
             );\
             INSERT INTO effect_sql_migrations (migration_id, name)\
             VALUES (33, 'ProjectionThreadsKind');\
             CREATE TABLE legacy_user_data (value TEXT NOT NULL);\
             INSERT INTO legacy_user_data (value) VALUES ('keep-me');",
        )?;

        assert!(run_migrations(&mut connection, None)?.is_empty());
        let value = connection.query_row("SELECT value FROM legacy_user_data", [], |row| {
            row.get::<_, String>(0)
        })?;
        assert_eq!(value, "keep-me");

        Ok(())
    }

    #[test]
    fn rolls_back_ledger_and_schema_when_a_migration_fails() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(4))?;
        connection.execute_batch("CREATE TABLE projection_projects (dummy TEXT)")?;

        assert!(run_migrations(&mut connection, Some(5)).is_err());

        let latest = connection.query_row(
            "SELECT MAX(migration_id) FROM effect_sql_migrations",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(latest, 4);

        let created_during_failed_migration = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' AND name = 'projection_threads'",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(created_during_failed_migration, 0);

        Ok(())
    }

    #[test]
    fn canonicalizes_legacy_model_options_in_text_json() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(25))?;
        connection.execute(
            "INSERT INTO projection_threads (\
               thread_id, project_id, title, branch, worktree_path, latest_turn_id,\
               created_at, updated_at, deleted_at, runtime_mode, interaction_mode,\
               archived_at, model_selection_json\
             ) VALUES (\
               'thread-1', 'project-1', 'Thread', NULL, NULL, NULL,\
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,\
               'full-access', 'default', NULL,\
               '{\"provider\":\"codex\",\"model\":\"gpt-5.4\",\"options\":{\"effort\":\"max\",\"fastMode\":false,\"empty\":\"  \",\"count\":2}}'\
             )",
            [],
        )?;

        run_migrations(&mut connection, Some(26))?;

        let selection = connection.query_row(
            "SELECT model_selection_json FROM projection_threads WHERE thread_id = 'thread-1'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        let selection: serde_json::Value = serde_json::from_str(&selection).unwrap();
        assert_eq!(
            selection["options"],
            serde_json::json!([
                { "id": "effort", "value": "max" },
                { "id": "fastMode", "value": false }
            ])
        );

        Ok(())
    }

    #[test]
    fn migration_31_invalidates_role_credentials_and_installs_scope_columns() -> rusqlite::Result<()>
    {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(30))?;
        connection.execute(
            "INSERT INTO auth_sessions (\
               session_id, subject, role, method, issued_at, expires_at\
             ) VALUES ('session-1', 'subject-1', 'admin', 'pairing',\
               '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
            [],
        )?;

        run_migrations(&mut connection, Some(31))?;

        let session_count =
            connection.query_row("SELECT COUNT(*) FROM auth_sessions", [], |row| {
                row.get::<_, u32>(0)
            })?;
        assert_eq!(session_count, 0);

        let columns = connection
            .prepare("PRAGMA table_info(auth_sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(columns.iter().any(|column| column == "scopes"));
        assert!(!columns.iter().any(|column| column == "role"));

        Ok(())
    }
}
