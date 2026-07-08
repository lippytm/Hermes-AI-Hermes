/**
 * Hermes Engine — Cloudflare Worker host (v2, AI-triage layer wired in)
 * ----------------------------------------------------------------
 * SUPERSEDES index.ts. To activate: change wrangler.toml's `main` field
 * from "src/index.ts" to "src/index.v2.ts" (one line), then wrangler deploy.
 * Kept as a separate file rather than overwriting index.ts because this
 * push could only create new files, not update the existing one in place.
 *
 * Runs on Cloudflare Cron Triggers. Writes every finding into the
 * hermes-findings D1 database (binding: HERMES_DB).
 *
 * WHAT THIS DOES NOW:
 *   1. Pulls the live fleet manifest from GitHub, walks every repo
 *      (skips `deprioritized`).
 *   2. For each repo, fetches README.md and checks every link for
 *      dead-link status (link-health skill, for real — actual HTTP
 *      checks, not a placeholder).
 *   3. Also pulls each repo's open_issues_count (repo-triage skill).
 *   4. If dead links are found AND ANTHROPIC_API_KEY is set, calls
 *      Claude (claude-fable-5) to draft a corrected README.
 *   5. GUARDRAIL, enforced in code:
 *        - governance / revenue_critical tiers: dead links and issue
 *          counts are only ever logged as `reported_only`. No branch,
 *          no PR, no exceptions, regardless of what the AI drafts.
 *        - standard tier: if a fix was drafted AND GITHUB_TOKEN is set,
 *          opens a DRAFT pull request (never auto-merges — this Worker
 *          has no CI gate wired in yet, so merging stays a human step).
 *   6. Every outcome — fixed-and-PR'd, drafted-but-no-token,
 *      no-fix-needed, dead-links-found-but-no-api-key — is written to
 *      hermes_findings so nothing is silently lost.
 *
 * SETUP:
 *   wrangler secret put GITHUB_TOKEN        (needs repo write scope for PRs)
 *   wrangler secret put ANTHROPIC_API_KEY   (optional — without it, findings
 *                                             are still logged, just no AI fix)
 *   wrangler secret put SLACK_WEBHOOK_URL   (optional)
 *   wrangler deploy
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
    return new Response("Hermes engine is alive. GET /run?type=manual_scan or /findings.", { status: 200 });
  },
};
