-- hermes_audit_events — append-only audit trail for the Hermes swarm fabric.
-- Created as part of v4 (Swarm Fabric layer).
--
-- Run against the HERMES_DB D1 database:
--   wrangler d1 execute hermes-findings --file=sql/hermes_audit_events_schema.sql
--
-- IMPORTANT: This table is append-only.
-- No UPDATE or DELETE statements should ever target hermes_audit_events.
-- The audit trail must remain intact for governance and compliance review.
--
-- Event types mirror the audit requirements in:
--   docs/agents/E6C-CHAR-009-019-hermes-dispatch.md
--
-- Valid event_type values (enforced in application code, not by constraint
-- to allow forward-compatible addition of new event types without DDL changes):
--   AGENT_DISPATCHED
--   AGENT_SKIPPED_EXPIRED
--   AGENT_SKIPPED_TIER
--   REPO_CLAIM_ACQUIRED
--   REPO_CLAIM_BLOCKED
--   REPO_CLAIM_RELEASED
--   FINDING_RECORDED
--   PR_OPENED
--   ESCALATED
--   GATE_FAILED
--   STOP_WORK
--   SWARM_COMPLETED

CREATE TABLE IF NOT EXISTS hermes_audit_events (
  id             INTEGER  PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT     NOT NULL,
  model_line     TEXT     NOT NULL,
  event_type     TEXT     NOT NULL,
  repo_name      TEXT     NOT NULL,
  repo_tier      TEXT     NOT NULL DEFAULT 'unknown',
  detail         TEXT     NOT NULL DEFAULT '',
  work_packet_id TEXT,
  created_at     DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Index for the most common query patterns:
--   /swarm/audit?agent=<id>     — filter by agent
--   /swarm/audit?repo=<name>    — filter by repo
--   /swarm/status last run      — filter by agent + event_type, order by created_at

CREATE INDEX IF NOT EXISTS idx_audit_agent
  ON hermes_audit_events (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_repo
  ON hermes_audit_events (repo_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_type
  ON hermes_audit_events (event_type, created_at DESC);
