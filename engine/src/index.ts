/**
 * Hermes Engine — Cloudflare Worker host
 * ----------------------------------------------------------------
 * This is the actual "host" the Hermes pack has been waiting on since
 * hermes-agent-integration.zip (v1). It runs on Cloudflare's free Cron
 * Triggers — no VPS, no idle billing — and writes every finding into
 * the hermes-findings D1 database (binding: HERMES_DB) created 2026-07-02.
 *
 * WHAT THIS DOES TODAY:
 *   - On each scheduled tick, pulls the live fleet manifest from GitHub
 *     (hermes-fleet-manifest-v6-truthed.yaml) and walks every repo.
 *   - For each repo, opens a "scan" finding row in D1 recording tier,
 *     schedule type, and a placeholder result.
 *   - Strictly enforces the tier guardrail at the code level: any repo
 *     tagged revenue_critical is NEVER written with status auto_fixed —
 *     only reported_only or pr_opened_pending_review are allowed.
 *
 * WHAT THIS DOES NOT DO YET (next layer, intentionally left to you):
 *   - Actual AI-driven triage/fix generation. hermes-config.yaml already
 *     defines the model routing (Anthropic primary, Gemini for bulk,
 *     OpenAI cross-check, OpenRouter fallback) — wire that in here once
 *     you're ready to move past the scan bootstrap layer. That means:
 *     adding ANTHROPIC_API_KEY etc. as `wrangler secret put` and calling
 *     the model from inside the switch-case below per finding_type.
 *   - Opening real GitHub PRs for fixes (needs GITHUB_TOKEN write scope
 *     for the create_or_update_file / create_pull_request calls).
 *
 * SETUP (one-time):
 *   1. cd into this folder, `npm install -g wrangler` if you don't have it
 *   2. `wrangler secret put GITHUB_TOKEN`        (repo:read is enough for now)
 *   3. `wrangler secret put SLACK_WEBHOOK_URL`   (optional — #hermes-reports)
 *   4. `wrangler deploy`
 * That's it — the D1 binding and cron schedule are already in wrangler.toml.
 */

export interface Env {
  HERMES_DB: D1Database;
  GITHUB_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string;
}

const MANIFEST_URL =
  "https://raw.githubusercontent.com/lippytm/Hermes-AI-Hermes/main/hermes-fleet-manifest-v6-truthed.yaml";

interface ManifestRepo {
  name: string;
  tier: "governance" | "revenue_critical" | "standard" | "deprioritized";
}

/** Minimal, dependency-free YAML reader for this manifest's known shape. */
function parseManifest(yaml: string): ManifestRepo[] {
  const repos: ManifestRepo[] = [];
  const sectionTier: Record<string, ManifestRepo["tier"]> = {
    governance_repos: "governance",
    revenue_critical_repos: "revenue_critical",
    standard_repos: "standard",
    deprioritized_repos: "deprioritized",
  };
  let currentTier: ManifestRepo["tier"] | null = null;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^([a-z_]+):\s*$/);
    if (sectionMatch && sectionMatch[1] in sectionTier) {
      currentTier = sectionTier[sectionMatch[1]];
      continue;
    }
    if (/^[a-z_]+:\s*$/.test(line) && !(sectionMatch && sectionMatch[1] in sectionTier)) {
      currentTier = null; // left a tracked section
    }
    if (currentTier) {
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+)\s*$/);
      if (nameMatch) {
        repos.push({ name: nameMatch[1].trim(), tier: currentTier });
      }
    }
  }
  return repos;
}

async function recordFinding(
  env: Env,
  repo: ManifestRepo,
  findingType: string,
  status: "auto_fixed" | "pr_opened_pending_review" | "escalated" | "reported_only",
  description: string
) {
  // Hard guardrail, enforced in code (not just config): revenue_critical
  // and governance repos can never receive status = auto_fixed.
  const safeStatus =
    (repo.tier === "revenue_critical" || repo.tier === "governance") && status === "auto_fixed"
      ? "reported_only"
      : status;

  await env.HERMES_DB.prepare(
    `INSERT INTO hermes_findings (repo_name, repo_tier, finding_type, risk_level, status, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      repo.name,
      repo.tier,
      findingType,
      repo.tier === "revenue_critical" ? "high" : "low",
      safeStatus,
      description
    )
    .run();
}

async function runScan(env: Env, scheduleLabel: string) {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText}`);
  }
  const yaml = await res.text();
  const repos = parseManifest(yaml);

  for (const repo of repos) {
    if (repo.tier === "deprioritized") continue; // skip ClawBot family etc.
    await recordFinding(
      env,
      repo,
      scheduleLabel,
      "reported_only",
      `Automated ${scheduleLabel} scan bootstrap ran. AI triage layer not yet wired in — see index.ts header.`
    );
  }

  if (env.SLACK_WEBHOOK_URL) {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Hermes engine: ${scheduleLabel} completed across ${repos.length} tracked repos.`,
      }),
    }).catch(() => {}); // never let a Slack failure fail the scan
  }

  return repos.length;
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
    const label = scheduleLabelForCron(event.cron);
    ctx.waitUntil(runScan(env, label));
  },

  // Manual trigger + health check, e.g. GET /run?type=nightly_scan
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const label = url.searchParams.get("type") || "manual_scan";
      const count = await runScan(env, label);
      return Response.json({ ok: true, scanned: count, label });
    }
    if (url.pathname === "/findings") {
      const { results } = await env.HERMES_DB.prepare(
        "SELECT * FROM hermes_findings ORDER BY detected_at DESC LIMIT 25"
      ).all();
      return Response.json(results);
    }
    return new Response(
      "Hermes engine is alive. GET /run?type=manual_scan or /findings.",
      { status: 200 }
    );
  },
};
