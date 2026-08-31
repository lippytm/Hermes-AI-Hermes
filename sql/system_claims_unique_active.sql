-- system_claims_unique_active.sql
-- Adds a partial unique index on system_claims to ensure at most one
-- unreleased (active) claim exists per repo at any time.
--
-- This makes claimRepoForAgent() atomic: instead of a racy SELECT-then-INSERT,
-- the INSERT itself fails with a unique constraint violation if another active
-- claim already exists, and the caller treats that as a blocked-claim signal.
--
-- Run BEFORE deploying index.v4.ts (or alongside hermes_audit_events_schema.sql):
--   wrangler d1 execute hermes-findings --file=sql/system_claims_unique_active.sql
--
-- NOTE: SQLite partial indexes (WHERE clause on CREATE UNIQUE INDEX) are
-- supported in SQLite ≥ 3.8.9 and in Cloudflare D1.

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_claims_active_repo
  ON system_claims (repo_name)
  WHERE released_at IS NULL;
