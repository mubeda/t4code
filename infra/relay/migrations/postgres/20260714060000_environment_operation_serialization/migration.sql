ALTER TABLE "relay_managed_endpoint_allocations"
  ADD COLUMN "operation_generation" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "operation_owner_token" varchar(64);

CREATE TABLE "relay_environment_operations" (
  "environment_id" varchar(191) PRIMARY KEY NOT NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "owner_token" varchar(64),
  "owner_user_id" varchar(191),
  "operation_kind" varchar(32),
  "lease_expires_at" varchar(64),
  "created_at" varchar(64) NOT NULL,
  "updated_at" varchar(64) NOT NULL
);

CREATE INDEX "idx_relay_environment_operations_lease"
  ON "relay_environment_operations" ("lease_expires_at");

WITH ranked_active_credentials AS (
  SELECT
    "credential_id",
    row_number() OVER (
      PARTITION BY "environment_id", "environment_public_key"
      ORDER BY "updated_at" DESC, "credential_id" DESC
    ) AS active_rank
  FROM "relay_environment_credentials"
  WHERE "revoked_at" IS NULL
)
UPDATE "relay_environment_credentials" AS credentials
SET
  "revoked_at" = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM ranked_active_credentials
WHERE credentials."credential_id" = ranked_active_credentials."credential_id"
  AND ranked_active_credentials.active_rank > 1;

CREATE UNIQUE INDEX "idx_relay_environment_credentials_active_environment_key"
  ON "relay_environment_credentials" ("environment_id", "environment_public_key")
  WHERE "revoked_at" IS NULL;
