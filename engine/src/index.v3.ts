/**
 * Hermes Engine — Cloudflare Worker host (v3)
 * ----------------------------------------------------------------
 * Adds HTTP claims endpoints on top of v2's AI-triage logic, so
 * external systems (Zo Space, or anything that can make an HTTP call)
 * can join the same coordination ledger Hermes and Claude already
 * write to directly via D1 — without needing Cloudflare account access.
 *
 * ACTIVATE: change wrangler.toml's `main` from "src/index.ts" to
 * "src/index.v3.ts", then `wrangler deploy`.
 *
 * NEW IN v3 — the Zo Space integration surface:
 *
 *   GET  /claims?repo=<name>
 *     Returns active (unreleased) claims for a repo. Call this BEFORE
 *     opening an issue/PR on a repo to check if another system is
 *     already working on it.
 *
 *   POST /claim
 *     Header: X-Hermes-Secret: <ZO_SHARED_SECRET>
 *     Body (JSON): {
 *       "repo_name": "lippytmai.getbizfunds.com-",
 *       "claimed_by": "zo_space",
 *       "action_type": "issue" | "pr" | "file_edit" | "comment" | "monitoring",
 *       "reference_url": "https://github.com/...",
 *       "notes": "optional free text"
 *     }
 *     Writes a claim row. Requires the shared secret so this isn't an
 *     open write endpoint to the internet.
 *
 *   POST /claim/release
 *     Header: X-Hermes-Secret: <ZO_SHARED_SECRET>
 *     Body: { "claim_id": 123 }
 *     Marks a claim released (work finished, no longer blocking).
 *
 * SETUP (in addition to v2's secrets):
 *   wrangler secret put ZO_SHARED_SECRET
 *   Give that same secret value to whoever configures Zo Space's
 *   outbound HTTP call. Zo Space needs: the deployed Worker URL
 *   (shown after `wrangler deploy`) + this secret, nothing else —
 *   no Cloudflare account access required on Zo's side.
 */

import {
  getFile,
  getOpenIssueCount,
  extractLinks,
  isLinkDead,
  createBranch,
  updateFile,
  openDraftPR,
  draftLinkFix,
} from "./lib/github-ai";

export interface Env {
  HERMES_DB: D1Database;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  ZO_SHARED_SECRET?: string;
}

const ORG = "lippytm";
const MANIFEST_URL = `https://raw.githubusercontent.com/${ORG}/Hermes-AI-Hermes/main/hermes-fleet-manifest-v6-truthed.yaml`;

type Tier = "governance" | "revenue_critical" | "standard" | "deprioritized";
interface ManifestRepo {
  name: string;
  tier: Tier;
}

function parseManifest(yaml: string): ManifestRepo[] {
  const repos: ManifestRepo[] = [];
  const sectionTier: Record<string, Tier> = {
    governance_repos: "governance",
    revenue_critical_repos: "revenue_critical",
    standard_repos: "standard",
    deprioritized_repos: "deprioritized",
  };
  let currentTier: Tier | null = null;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^([a-z_]+):\s*$/);
    if (sectionMatch && sectionMatch[1] in sectionTier) {
      currentTier = sectionTier[sectionMatch[1]];
      continue;
    }
    if (/^[a-z_]+:\s*$/.test(line) && !(sectionMatch && sectionMatch[1] in sectionTier)) {
      currentTier = null;
    }
    if (currentTier) {
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+)\s*$/);
      if (nameMatch) repos.push({ name: nameMatch[1].trim(), tier: currentTier });
    }
  }
  return repos;
}

type Status = "auto_fixed" | "pr_opened_pending_review" | "escalated" | "reported_only";

async function recordFinding(
  env: Env,
  repo: ManifestRepo,
  findingType: string,
  status: Status,
  riskLevel: "low" | "medium" | "high",
  description: string,
  prUrl?: string | null
) {
  const locked = repo.tier === "revenue_critical" || repo.tier === "governance";
  const safeStatus: Status = locked && status !== "reported_only" ? "reported_only" : status;

  await env.HERMES_DB.prepare(
    `INSERT INTO hermes_findings (repo_name, repo_tier, finding_type, risk_level, status, pr_url, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(repo.name, repo.tier, findingType, riskLevel, safeStatus, prUrl || null, description)
    .run();
}

async function triageRepo(env: Env, repo: ManifestRepo, scheduleLabel: string) {
  const locked = repo.tier === "revenue_critical" || repo.tier === "governance";

  const issueCount = await getOpenIssueCount(ORG, repo.name, env.GITHUB_TOKEN);
  if (issueCount !== null && issueCount > 0) {
    await recordFinding(
      env,
      repo,
      "repo_triage_open_issues",
      "reported_only",
      "low",
      `${issueCount} open issue(s) at time of ${scheduleLabel}.`
    );
  }

  const readme = await getFile(ORG, repo.name, "README.md", env.GITHUB_TOKEN);
  if (!readme) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", "No README.md found or unreadable.");
    return;
  }

  const links = extractLinks(readme.content);
  if (links.length === 0) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", "README has no external links to check.");
    return;
  }

  const deadChecks = await Promise.all(links.map(async (l) => ({ ...l, dead: await isLinkDead(l.url) })));
  const deadLinks = deadChecks.filter((l) => l.dead);

  if (deadLinks.length === 0) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", `All ${links.length} link(s) healthy.`);
    return;
  }

  const deadList = deadLinks.map((l) => `${l.text}: ${l.url}`).join("; ");

  if (locked) {
    await recordFinding(
      env,
      repo,
      "dead_link_fix",
      "reported_only",
      "high",
      `${deadLinks.length} dead link(s) found: ${deadList}. Tier-locked — no automated fix attempted.`
    );
    return;
  }

  const fixed = await draftLinkFix(env.ANTHROPIC_API_KEY, readme.content, deadLinks);
  if (!fixed) {
    await recordFinding(
      env,
      repo,
      "dead_link_fix",
      "escalated",
      "medium",
      `${deadLinks.length} dead link(s) found: ${deadList}. No ANTHROPIC_API_KEY configured or draft failed — needs manual fix.`
    );
    return;
  }

  if (!env.GITHUB_TOKEN) {
    await recordFinding(
      env,
      repo,
      "dead_link_fix",
      "escalated",
      "medium",
      `AI drafted a fix for ${deadLinks.length} dead link(s) but GITHUB_TOKEN isn't set — can't open a PR.`
    );
    return;
  }

  const branch = `hermes-link-fix-${new Date().toISOString().slice(0, 10)}`;
  const branchOk = await createBranch(ORG, repo.name, branch, "main", env.GITHUB_TOKEN);
  if (!branchOk) {
    await recordFinding(env, repo, "dead_link_fix", "escalated", "medium", "AI drafted a fix but branch creation failed.");
    return;
  }

  const updateOk = await updateFile(
    ORG,
    repo.name,
    "README.md",
    branch,
    fixed,
    readme.sha,
    `hermes: fix ${deadLinks.length} dead link(s) in README`,
    env.GITHUB_TOKEN
  );
  if (!updateOk) {
    await recordFinding(env, repo, "dead_link_fix", "escalated", "medium", "AI drafted a fix but commit to branch failed.");
    return;
  }

  const prUrl = await openDraftPR(
    ORG,
    repo.name,
    branch,
    "main",
    `Hermes: fix ${deadLinks.length} dead link(s) in README`,
    `Automated by the Hermes engine (${scheduleLabel}). Dead links found: ${deadList}\n\nThis is a **draft PR** — Hermes never auto-merges. Review before merging.`,
    env.GITHUB_TOKEN
  );

  await recordFinding(
    env,
    repo,
    "dead_link_fix",
    prUrl ? "pr_opened_pending_review" : "escalated",
    "medium",
    prUrl ? `Draft PR opened with AI-fixed links.` : "Fix committed to branch but PR creation failed.",
    prUrl
  );
}

async function runScan(env: Env, scheduleLabel: string) {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
  const repos = parseManifest(await res.text());

  let scanned = 0;
  for (const repo of repos) {
    if (repo.tier === "deprioritized") continue;
    await triageRepo(env, repo, scheduleLabel);
    scanned++;
  }

  if (env.SLACK_WEBHOOK_URL) {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `Hermes engine: ${scheduleLabel} completed across ${scanned} repos.` }),
    }).catch(() => {});
  }

  return scanned;
}

function scheduleLabelForCron(cron: string): string {
  switch (cron) {
    case "0 6 * * *":
      return "nightly_scan";
    case "0 7 * * 1":
      return "deep_audit";
    case "0 5 * * *":
      return "self_heal";
    case "0 8 * * 1":
      return "weekly_link_health";
    default:
      return "unscheduled_scan";
  }
}

// ---- Claims endpoints (the Zo Space integration surface) ----

function checkAuth(request: Request, env: Env): boolean {
  if (!env.ZO_SHARED_SECRET) return false;
  return request.headers.get("X-Hermes-Secret") === env.ZO_SHARED_SECRET;
}

async function handleGetClaims(env: Env, repo: string): Promise<Response> {
  const { results } = await env.HERMES_DB.prepare(
    `SELECT id, repo_name, claimed_by, action_type, reference_url, claimed_at, notes
     FROM system_claims
     WHERE repo_name = ? AND released_at IS NULL
     ORDER BY claimed_at DESC`
  )
    .bind(repo)
    .all();
  return Response.json({ repo, active_claims: results });
}

async function handlePostClaim(request: Request, env: Env): Promise<Response> {
  if (!checkAuth(request, env)) {
    return Response.json({ error: "Unauthorized. Set X-Hermes-Secret header." }, { status: 401 });
  }
  const body: any = await request.json().catch(() => null);
  if (!body?.repo_name || !body?.claimed_by || !body?.action_type) {
    return Response.json(
      { error: "Required fields: repo_name, claimed_by, action_type" },
      { status: 400 }
    );
  }
  const result = await env.HERMES_DB.prepare(
    `INSERT INTO system_claims (repo_name, claimed_by, action_type, reference_url, notes)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.repo_name, body.claimed_by, body.action_type, body.reference_url || null, body.notes || null)
    .run();
  return Response.json({ ok: true, claim_id: result.meta.last_row_id });
}

async function handleReleaseClaim(request: Request, env: Env): Promise<Response> {
  if (!checkAuth(request, env)) {
    return Response.json({ error: "Unauthorized. Set X-Hermes-Secret header." }, { status: 401 });
  }
  const body: any = await request.json().catch(() => null);
  if (!body?.claim_id) {
    return Response.json({ error: "Required field: claim_id" }, { status: 400 });
  }
  await env.HERMES_DB.prepare(`UPDATE system_claims SET released_at = datetime('now') WHERE id = ?`)
    .bind(body.claim_id)
    .run();
  return Response.json({ ok: true });
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScan(env, scheduleLabelForCron(event.cron)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const label = url.searchParams.get("type") || "manual_scan";
      const count = await runScan(env, label);
      return Response.json({ ok: true, scanned: count, label });
    }

    if (url.pathname === "/findings") {
      const { results } = await env.HERMES_DB.prepare(
        "SELECT * FROM hermes_findings ORDER BY detected_at DESC LIMIT 50"
      ).all();
      return Response.json(results);
    }

    if (url.pathname === "/claims" && request.method === "GET") {
      const repo = url.searchParams.get("repo");
      if (!repo) return Response.json({ error: "?repo=<name> required" }, { status: 400 });
      return handleGetClaims(env, repo);
    }

    if (url.pathname === "/claim" && request.method === "POST") {
      return handlePostClaim(request, env);
    }

    if (url.pathname === "/claim/release" && request.method === "POST") {
      return handleReleaseClaim(request, env);
    }

    return new Response(
      "Hermes engine v3 is alive. GET /run?type=manual_scan | /findings | /claims?repo=X | POST /claim | POST /claim/release",
      { status: 200 }
    );
  },
};
