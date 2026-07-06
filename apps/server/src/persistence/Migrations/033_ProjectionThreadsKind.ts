import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'
  `;

  yield* sql`
    UPDATE projection_threads
    SET kind = 'workspace'
    WHERE kind IS NULL
  `;
});
