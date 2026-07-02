# Wiring Zo Space into the Hermes coordination ledger (v2 — corrected)

**This replaces `ZO_SPACE_INTEGRATION.md`.** That first version guessed at a generic webhook/HTTP-step approach because I didn't know what Zo Space actually was. I've since confirmed: **Zo Computer (zo.computer) is a real product with a native Cloudflare integration** (`zo.computer/integrations/cloudflare`: "Workers, R2, D1, Pages, Zero Trust — query and (optionally) deploy") and a native GitHub integration. That changes the recommended path completely — no webhook needed.

## The real path: connect Zo directly to the same D1 database

1. In zo.computer, find **Integrations** (referenced in Zo's own site nav) and connect **Cloudflare**, using the same Cloudflare account that owns the `hermes-findings` D1 database.
2. Once connected, Zo can query and write to the exact same tables Hermes and Claude already use:
   - `hermes_findings` — database uuid `88ca2414-372e-4542-926e-8ea6c9d7c6c7`
   - `system_registry` — lists every known system and what it's allowed to do
   - `system_claims` — the coordination ledger; check this before opening an issue/PR, write to it when you do
3. Zo Space is already registered in `system_registry` (updated 2026-07-02) with `can_write_code = 1` and `can_open_prs = 1`, matching what it's already demonstrated (it opened 6 issues in this org). `can_auto_merge` stays `0` — same rule every system in this org follows.

## Before Zo Space opens anything on a repo, have it run
```sql
SELECT * FROM system_claims WHERE repo_name = '<repo>' AND released_at IS NULL;
```
If that returns rows, something's already in flight there from another system — coordinate instead of duplicating.

## After Zo Space acts, have it log
```sql
INSERT INTO system_claims (repo_name, claimed_by, action_type, reference_url, notes)
VALUES ('<repo>', 'zo_space', 'issue', '<github url>', '<what it did>');
```

## Bonus: Zo Space could deploy the Hermes engine itself
Since Zo's Cloudflare integration says it can "optionally deploy," and it already has GitHub access to this org, Zo Space may be able to run the one manual step still blocking full Hermes automation: `wrangler deploy` from the `engine/` folder (after setting `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `ZO_SHARED_SECRET` as Worker secrets). Worth checking whether Zo's Cloudflare integration exposes a deploy action — if so, that closes the deployment gap that's been open since the first Hermes conversation.

## Fallback: the HTTP claims endpoints from `ZO_SPACE_INTEGRATION.md` (v1)
Still valid if, for whatever reason, connecting Zo's Cloudflare integration to this specific database isn't possible (e.g. different Cloudflare account). The `/claims`, `/claim`, and `/claim/release` HTTP endpoints in `engine/src/index.v3.ts` work for any system that can make an HTTP call, Zo included.

## What I still can't verify from here
I don't have a Zo Computer account, so I can't confirm exactly what the "connect Cloudflare" flow looks like inside Zo's UI, whether it asks for scoped API tokens vs. full account access, or whether its "deploy" capability covers Worker deploys specifically (vs. just Pages). If you get partway through and hit a specific screen, tell me what it's asking for and I can help interpret it.
