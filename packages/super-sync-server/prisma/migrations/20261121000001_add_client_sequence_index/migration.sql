-- Serves the lookup of the highest server number a browser's own saves hold, read on every download.
-- Drop first so a rerun can recover from a failed CONCURRENTLY build that left an INVALID index behind.
DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_client_id_server_seq_idx";
CREATE INDEX CONCURRENTLY "operations_user_id_client_id_server_seq_idx"
  ON "operations"("user_id", "client_id", "server_seq");

-- The new index leads with the same two columns, so it serves every lookup the old one did.
DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_client_id_idx";
