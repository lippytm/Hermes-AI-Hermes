/**
 * swarm.ts — Hermes Fabric Swarm helpers
 * ---------------------------------------
 * Provides the SwarmAgent manifest, passport types, D1 claim/release
 * wrappers, audit-event writer, and expiry check used by index.v4.ts.
 *
 * The four agents map 1-to-1 to the four lippytm clone identities:
 *   charles-principal  → Charles Earl Lipshay (human authority mirror)
 *   lippytm-builder    → lippytm (builder / GitHub identity)
 *   lippytmai-brand    → lippytmai (AI brand / product identity)
 *   lippy-killjoy      → Lippy Killjoy (creative / red-team identity)
 *
 * Agent Passport fields mirror the requirements in:
 *   docs/agents/E6C-CHAR-009-019-hermes-dispatch.md
 *
 * HumanApprovalGate note (enforced here, not just in docs):
 *   No agent — including swarm-vote consensus — can pass HumanApprovalGate.
 *   The dispatcher checks `prohibited_actions` before every GitHub write and
 *   will never call openDraftPR or updateFile for a prohibited agent.
 */

export type Tier = "governance" | "revenue_critical" | "standard" | "deprioritized";
export type ModelLine = "CGPT" | "GEM" | "CLH" | "CMP" | "MERGED-PREM";
export type ActionType =
  | "monitoring"
  | "link_health"
  | "issue_triage"
  | "stale_branch_scan"
  | "identity_audit"
  | "open_pr"
  | "commit"
  | "escalation";

export interface SwarmPassport {
  agent_id: string;
  display_name: string;
  model_line: ModelLine;
  /** Tiers this agent is permitted to act on. */
  permitted_tiers: Tier[];
  /** Action types this agent may perform. */
  allowed_action_types: ActionType[];
  /** Action types explicitly prohibited — checked before every write. */
  prohibited_actions: ActionType[];
  /** ISO-8601 datetime or null (never expires). */
  expiration_at: string | null;
}

/** The four clone-identity agents. */
export const SWARM_AGENTS: SwarmPassport[] = [
  {
    agent_id: "charles-principal",
    display_name: "Charles Earl Lipshay — Human Authority Mirror",
    model_line: "CMP",
    permitted_tiers: ["governance", "revenue_critical", "standard"],
    allowed_action_types: ["monitoring", "escalation"],
    prohibited_actions: ["open_pr", "commit", "link_health", "stale_branch_scan", "identity_audit"],
    expiration_at: null,
  },
  {
    agent_id: "lippytm-builder",
    display_name: "lippytm — Builder / GitHub Identity",
    model_line: "CLH",
    permitted_tiers: ["standard"],
    allowed_action_types: ["link_health", "issue_triage", "open_pr", "commit", "escalation"],
    prohibited_actions: ["identity_audit"],
    expiration_at: null,
  },
  {
    agent_id: "lippytmai-brand",
    display_name: "lippytmai — AI Brand / Product Identity",
    model_line: "CGPT",
    permitted_tiers: ["revenue_critical", "standard"],
    allowed_action_types: ["link_health", "monitoring", "escalation"],
    prohibited_actions: ["open_pr", "commit", "identity_audit"],
    expiration_at: null,
  },
  {
    agent_id: "lippy-killjoy",
    display_name: "Lippy Killjoy — Red-Team / Adversarial Auditor",
    model_line: "GEM",
    permitted_tiers: ["governance", "revenue_critical", "standard"],
    allowed_action_types: ["identity_audit", "stale_branch_scan", "issue_triage", "monitoring", "escalation"],
    prohibited_actions: ["open_pr", "commit"],
    expiration_at: null,
  },
];

/** Returns true if the agent's passport has expired. */
export function isAgentExpired(agent: SwarmPassport): boolean {
  if (!agent.expiration_at) return false;
  return new Date(agent.expiration_at) < new Date();
}

/** Returns true if the agent is allowed to perform the given action type. */
export function agentCanDo(agent: SwarmPassport, action: ActionType): boolean {
  if (agent.prohibited_actions.includes(action)) return false;
  return agent.allowed_action_types.includes(action);
}

// ── D1 environment surface (minimal — only what swarm.ts needs) ────────────
export interface SwarmEnv {
  HERMES_DB: D1Database;
}

// ── Claim helpers ──────────────────────────────────────────────────────────

/**
 * Attempts to register a claim for `agent` on `repo_name`.
 * Returns the claim ID on success, or null if another active claim blocks it.
 */
export async function claimRepoForAgent(
  env: SwarmEnv,
  agent: SwarmPassport,
  repo_name: string
): Promise<number | null> {
  // Check for any existing active (unreleased) claim on this repo.
  const existing = await env.HERMES_DB.prepare(
    `SELECT id FROM system_claims WHERE repo_name = ? AND released_at IS NULL LIMIT 1`
  )
    .bind(repo_name)
    .first<{ id: number }>();

  if (existing) return null; // Another agent (or external system) has the claim.

  const result = await env.HERMES_DB.prepare(
    `INSERT INTO system_claims (repo_name, claimed_by, action_type, notes)
     VALUES (?, ?, ?, ?)`
  )
    .bind(repo_name, agent.agent_id, "monitoring", `Swarm run by ${agent.display_name}`)
    .run();

  return result.meta.last_row_id ?? null;
}

/** Releases a previously acquired claim. */
export async function releaseClaimForAgent(env: SwarmEnv, claim_id: number): Promise<void> {
  await env.HERMES_DB.prepare(
    `UPDATE system_claims SET released_at = datetime('now') WHERE id = ?`
  )
    .bind(claim_id)
    .run();
}

// ── Audit events ───────────────────────────────────────────────────────────

/**
 * Audit event types mirroring E6C-CHAR-009-019-hermes-dispatch.md.
 * Append-only — no UPDATE or DELETE on hermes_audit_events.
 */
export type AuditEventType =
  | "AGENT_DISPATCHED"
  | "AGENT_SKIPPED_EXPIRED"
  | "AGENT_SKIPPED_TIER"
  | "REPO_CLAIM_ACQUIRED"
  | "REPO_CLAIM_BLOCKED"
  | "REPO_CLAIM_RELEASED"
  | "FINDING_RECORDED"
  | "PR_OPENED"
  | "ESCALATED"
  | "GATE_FAILED"
  | "STOP_WORK"
  | "SWARM_COMPLETED";

export async function auditEvent(
  env: SwarmEnv,
  agent_id: string,
  model_line: ModelLine,
  event_type: AuditEventType,
  repo_name: string,
  repo_tier: string,
  detail: string,
  work_packet_id?: string | null
): Promise<void> {
  await env.HERMES_DB.prepare(
    `INSERT INTO hermes_audit_events
       (agent_id, model_line, event_type, repo_name, repo_tier, detail, work_packet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(agent_id, model_line, event_type, repo_name, repo_tier, detail, work_packet_id ?? null)
    .run();
}
