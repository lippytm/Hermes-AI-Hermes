# Wiring Zo Space into the Hermes coordination ledger

Written for Charles going into `lippytmai.zo.computer` directly. Goal: get Zo Space to check-in with Hermes before it opens issues/PRs on a repo, and vice versa, so the two stop duplicating work.

## What to look for in Zo Space's UI
Zo Space already makes outbound calls (it's already creating GitHub issues, and referencing Zapier + Dubb in its own issue templates). Look for whichever of these it has:
- A "workflow step" / "action" / "automation" builder where you can add a generic **HTTP request** step
- A "webhook" or "integrations" settings panel
- Anywhere it lets you add a **custom API call** before or after it does a GitHub action

If you find any of those, this is the one HTTP call to add **before** Zo Space opens a new issue or PR on a repo:

```
GET https://<your-worker-url>/claims?repo=<repo-name>
```

(The `<your-worker-url>` is whatever URL `wrangler deploy` gives you once the engine is live — looks like `https://hermes-engine.<your-subdomain>.workers.dev`.)

If the response's `active_claims` array is non-empty, Zo Space (or you, reading the response) knows Hermes or Claude already has something in flight on that repo — good moment to skip, wait, or coordinate instead of posting a duplicate.

## If Zo Space can also record its own claims
Same idea, in reverse — have it POST here right before it acts:

```
POST https://<your-worker-url>/claim
Header: X-Hermes-Secret: <the secret you set with `wrangler secret put ZO_SHARED_SECRET`>
Body:
{
  "repo_name": "lippytmai.getbizfunds.com-",
  "claimed_by": "zo_space",
  "action_type": "issue",
  "reference_url": "<link to what it's about to create>"
}
```

Then Hermes and Claude will see Zo Space's claims too, next time either of them checks before acting.

## If Zo Space genuinely can't make custom HTTP calls
That's a real possibility — not every workflow tool exposes raw HTTP steps. If that's what you find, the fallback is simpler and lower-tech: **just glance at the `#hermes-reports` Slack channel or the cross-linked GitHub issues before manually triggering a new Zo Space workflow on a repo Hermes has already touched.** Not automated, but it closes the same gap.

## What I can't do from here
I don't have visibility into Zo Space's actual interface — I'm giving you the integration surface (the endpoints) and the general pattern (workflow tools usually have *some* HTTP-call escape hatch), not exact click-by-click steps, because I don't know what UI Zo Space actually presents. If you find the right settings panel and get stuck on a specific field, tell me what you're looking at and I can help from there.
