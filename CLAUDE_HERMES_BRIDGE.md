# Claude ↔ Hermes Bridge

This documents a real integration pattern, not aspirational: **Claude (via Anthropic's Cloudflare Developer Platform connector) has direct read/write access to the same `hermes-findings` D1 database the Worker uses.** That means Claude can act as a manual Hermes run — recording findings, reviewing PRs, commenting on issues — independent of whether the scheduled Worker is deployed yet.

## Why this matters
The Worker (`engine/src/index.v2.ts`) is the *automated* path: runs on cron, no human in the loop for `reported_only`/`escalated` findings. Claude in a chat session is the *supervised* path: a human (Charles) is directly steering, and Claude can do things the Worker deliberately doesn't (write nuanced PR reviews, cross-reference multiple repos' context, make judgment calls about coordination between systems) while still writing to the exact same table, so nothing is siloed.

## Proven 2026-07-02
Claude wrote 4 real findings directly into `hermes_findings` in a live chat session, before the Worker was ever deployed:
- A dependency-PR risk assessment (`tower-control-ai` #72, eslint major bump)
- A cross-system coordination flag (Zo Space vs. Hermes overlap, `Prompt-11-` #1)
- Two Copilot-context findings recording the `.github/copilot-instructions.md` pushes

Query them yourself: `SELECT * FROM hermes_findings WHERE finding_type IN ('dependency_patch','system_coordination','copilot_context')`

## How to use this pattern going forward
Any Claude session with Cloudflare + GitHub access can:
1. Read current fleet state: query `hermes_findings` directly, or hit the deployed Worker's `/findings` endpoint
2. Write new findings using the same schema/tier rules the Worker enforces (never write `auto_fixed` for `revenue_critical`/`governance` tiers — same rule as `recordFinding()` in code)
3. Take actions the Worker can't yet (nuanced PR comments, cross-repo judgment calls, flagging things that need Charles's decision rather than automation)

This is the actual "Claude and Hermes working together" answer: not a separate integration to build, but Claude using the access it already has to the same source of truth the automated engine uses.
