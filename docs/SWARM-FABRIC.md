# Hermes Swarm Fabric

Hermes v4 upgrades the engine from a sequential single-threaded scanner into a **concurrent swarm fabric**: four named AI clone agents operate in parallel across the fleet, each scoped to the tiers and action types their passport permits.

---

## The Four Clone Agents

Each agent maps to one of the four lippytm identity layers (see `AI_CLONE_CHARACTER_SYSTEM.md`).

| Agent ID | Identity | Model Line | Permitted Tiers | Can Open PRs? |
|---|---|---|---|---|
| `charles-principal` | Charles Earl Lipshay — Human Authority Mirror | `CMP` | governance, revenue_critical, standard | No |
| `lippytm-builder` | lippytm — Builder / GitHub Identity | `CLH` | standard | Yes (draft only) |
| `lippytmai-brand` | lippytmai — AI Brand / Product Identity | `CGPT` | revenue_critical, standard | No |
| `lippy-killjoy` | Lippy Killjoy — Red-Team / Adversarial Auditor | `GEM` | governance, revenue_critical, standard | No |

### What each agent does

**`charles-principal`**  
Reads open issue counts across all non-deprioritized tiers and records them as `reported_only`. Acts as a passive human-authority mirror — never writes, never opens PRs. Governance and revenue-critical repos are within scope because observing them is safe; acting on them is not.

**`lippytm-builder`**  
Performs link-health checks on standard-tier repos. If dead links are found and `ANTHROPIC_API_KEY` is set, calls Claude to draft a corrected README and opens a **draft PR** (never auto-merges). The only agent allowed to commit and open PRs.

**`lippytmai-brand`**  
Performs link-health checks on revenue-critical and standard repos. Reports findings only — never commits or opens PRs. Escalates dead links for manual review on revenue-critical repos.

**`lippy-killjoy`**  
Red-team adversarial auditor. Scans for:
- Oversized issue backlogs (> 20 open issues → `escalated` / `high`)
- Identity-boundary violations in README content (e.g., unguarded claims about fictional abilities)

Covers all non-deprioritized tiers. `prohibited_actions: ["open_pr", "commit"]` is enforced at the dispatcher level before any GitHub write is attempted.

---

## SwarmPassport fields

Every agent carries a typed passport (`SwarmPassport` in `engine/src/lib/swarm.ts`):

| Field | Type | Description |
|---|---|---|
| `agent_id` | `string` | Unique stable identifier |
| `display_name` | `string` | Human-readable name |
| `model_line` | `ModelLine` | `CGPT \| GEM \| CLH \| CMP \| MERGED-PREM` |
| `permitted_tiers` | `Tier[]` | Tiers this agent may act on |
| `allowed_action_types` | `ActionType[]` | Actions the agent may perform |
| `prohibited_actions` | `ActionType[]` | Explicitly blocked actions — checked before every GitHub write |
| `expiration_at` | `string \| null` | ISO-8601 expiry or `null` (never expires) |

---

## Tier-permission matrix

| Tier | charles-principal | lippytm-builder | lippytmai-brand | lippy-killjoy |
|---|---|---|---|---|
| `governance` | ✅ monitor only | ❌ | ❌ | ✅ audit only |
| `revenue_critical` | ✅ monitor only | ❌ | ✅ report only | ✅ audit only |
| `standard` | ✅ monitor only | ✅ full (draft PR) | ✅ report only | ✅ audit only |
| `deprioritized` | ❌ | ❌ | ❌ | ❌ |

---

## Coordination: claim-based concurrency

Before any agent processes a repo, it attempts to acquire a row in the `system_claims` D1 table (already present from v3). If another agent (or an external system such as Zo Space) already holds an active (unreleased) claim on that repo, the agent skips it and records a `reported_only` finding. The claim is released (via `released_at`) in a `finally` block after triage completes, even on error.

This prevents double-work and integrates with the Zo Space coordination surface introduced in v3.

---

## Audit trail

Every agent action writes an append-only row to `hermes_audit_events` (see `sql/hermes_audit_events_schema.sql`). The table is **never updated or deleted** — it serves as the permanent governance audit trail.

Apply the schema before deploying v4:
```
wrangler d1 execute hermes-findings --file=sql/hermes_audit_events_schema.sql
```

Audit event types: `AGENT_DISPATCHED`, `AGENT_SKIPPED_EXPIRED`, `AGENT_SKIPPED_TIER`, `REPO_CLAIM_ACQUIRED`, `REPO_CLAIM_BLOCKED`, `REPO_CLAIM_RELEASED`, `FINDING_RECORDED`, `PR_OPENED`, `ESCALATED`, `GATE_FAILED`, `STOP_WORK`, `SWARM_COMPLETED`.

---

## HTTP endpoints

All v3 endpoints (`/run`, `/findings`, `/claims`, `/claim`, `/claim/release`) are preserved unchanged.

### New in v4

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/swarm/status` | None | Returns each agent's last run timestamp, active claim count, and total findings count |
| `GET` | `/swarm/audit` | None | Returns recent audit events. Query params: `?repo=<name>` and/or `?agent=<id>`. Returns up to 100 rows ordered by `created_at DESC` |
| `POST` | `/swarm/dispatch` | `X-Hermes-Secret` | Manually triggers a full swarm dispatch. Optional JSON body: `{ "label": "my_label" }` |

---

## HumanApprovalGate

Per the governance model in `docs/agents/E6C-CHAR-009-019-hermes-dispatch.md`:

> HumanApprovalGate cannot be passed by another AI agent, an automated score, a swarm vote, or Hermes itself.

This is enforced in code:
- No agent calls GitHub's merge endpoint (PRs are always `draft: true`).
- `charles-principal` and `lippy-killjoy` have `open_pr` and `commit` in `prohibited_actions` — the dispatcher checks this before any GitHub write and will reject the call.
- Swarm-vote consensus (majority of agents agreeing) does **not** unlock any gate.

---

## Deployment

1. Apply the new schema to D1:
   ```
   wrangler d1 execute hermes-findings --file=sql/hermes_audit_events_schema.sql
   ```

2. `wrangler.toml` already points `main` at `src/index.v4.ts`. Deploy:
   ```
   wrangler deploy
   ```

3. Secrets (set once, never committed):
   ```
   wrangler secret put GITHUB_TOKEN
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put SLACK_WEBHOOK_URL
   wrangler secret put ZO_SHARED_SECRET
   ```
