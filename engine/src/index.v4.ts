/**
 * Hermes Engine — Cloudflare Worker host (v4, Swarm Fabric layer)
 * ----------------------------------------------------------------
 * Extends v3 with a concurrent swarm dispatch system. Instead of a
 * single sequential scan, v4 fans out work to four named AI clone
 * agents, each scoped to the tiers and action types their passport
 * permits. Agents coordinate via the existing `system_claims` table
 * and emit append-only rows to `hermes_audit_events`.
 *
 * ACTIVATE: change wrangler.toml's `main` to "src/index.v4.ts",
 *           then `wrangler deploy`.
 *
 * AGENTS (see engine/src/lib/swarm.ts for full passport definitions):
 *   charles-principal  — monitoring + escalation only; governance + all tiers
 *   lippytm-builder    — link-health + draft PRs; standard tier only
 *   lippytmai-brand    — link-health + monitoring; revenue_critical + standard
 *   lippy-killjoy      — red-team audit; all tiers; NEVER opens PRs or commits
 *
 * NEW ENDPOINTS (in addition to v3's /run, /findings, /claim*):
 *   GET  /swarm/status
 *   GET  /swarm/audit?repo=<name>&agent=<id>
 *   POST /swarm/dispatch   (requires X-Hermes-Secret)
 *
 * GUARDRAILS (unchanged from v2/v3):
 *   - recordFinding() enforces tier-lock on governance/revenue_critical.
 *   - No agent can pass HumanApprovalGate or auto-merge anything.
 *   - lippy-killjoy has open_pr and commit in prohibited_actions — the
 *     dispatcher rejects those writes before they reach the GitHub API.
 *   - All PRs opened by lippytm-builder are draft: true.
 *
 * SETUP (secrets via `wrangler secret put`, never in source):
 *   wrangler secret put GITHUB_TOKEN        (repo write scope for PRs)
 *   wrangler secret put ANTHROPIC_API_KEY   (optional — AI link-fix drafts)
 *   wrangler secret put SLACK_WEBHOOK_URL   (optional — #hermes-reports)
 *   wrangler secret put ZO_SHARED_SECRET    (Zo Space integration, v3+)
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

import {
  SWARM_AGENTS,
  isAgentExpired,
  agentCanDo,
  claimRepoForAgent,
  releaseClaimForAgent,
  auditEvent,
  type SwarmPassport,
  type Tier,
  type AuditEventType,
} from "./lib/swarm";

// ── Env ────────────────────────────────────────────────────────────────────

export interface Env {
  HERMES_DB: D1Database;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  ZO_SHARED_SECRET?: string;
}

// ── Fleet manifest ─────────────────────────────────────────────────────────

const ORG = "lippytm";
const MANIFEST_URL = `https://raw.githubusercontent.com/${ORG}/Hermes-AI-Hermes/main/hermes-fleet-manifest-v6-truthed.yaml`;

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

// ── Finding recorder (tier-lock enforced here, unchanged from v2/v3) ───────

type Status = "auto_fixed" | "pr_opened_pending_review" | "escalated" | "reported_only";

async function recordFinding(
  env: Env,
  repo: ManifestRepo,
  findingType: string,
  status: Status,
  riskLevel: "low" | "medium" | "high",
  description: string,
  prUrl?: string | null
): Promise<void> {
  const locked = repo.tier === "revenue_critical" || repo.tier === "governance";
  const safeStatus: Status = locked && status !== "reported_only" ? "reported_only" : status;

  await env.HERMES_DB.prepare(
    `INSERT INTO hermes_findings (repo_name, repo_tier, finding_type, risk_level, status, pr_url, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(repo.name, repo.tier, findingType, riskLevel, safeStatus, prUrl || null, description)
    .run();
}

// ── Per-agent repo triage ──────────────────────────────────────────────────

async function triageRepoForAgent(
  env: Env,
  agent: SwarmPassport,
  repo: ManifestRepo,
  scheduleLabel: string,
  workPacketId: string
): Promise<void> {
  const locked = repo.tier === "revenue_critical" || repo.tier === "governance";

  // charles-principal and lippy-killjoy: monitoring / audit only paths.
  if (agent.agent_id === "charles-principal") {
    const issueCount = await getOpenIssueCount(ORG, repo.name, env.GITHUB_TOKEN);
    const desc =
      issueCount !== null
        ? `${issueCount} open issue(s) observed by ${agent.agent_id} at ${scheduleLabel}.`
        : `Could not fetch issue count for ${repo.name}.`;
    await recordFinding(env, repo, "repo_triage_open_issues", "reported_only", "low", desc);
    await auditEvent(env, agent.agent_id, agent.model_line, "FINDING_RECORDED", repo.name, repo.tier, desc, workPacketId);
    return;
  }

  if (agent.agent_id === "lippy-killjoy") {
    await runRedTeamAudit(env, agent, repo, scheduleLabel, workPacketId);
    return;
  }

  // lippytm-builder and lippytmai-brand: link-health triage.
  const readme = await getFile(ORG, repo.name, "README.md", env.GITHUB_TOKEN);
  if (!readme) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", "No README.md found or unreadable.");
    await auditEvent(env, agent.agent_id, agent.model_line, "FINDING_RECORDED", repo.name, repo.tier, "No README.md", workPacketId);
    return;
  }

  const links = extractLinks(readme.content);
  if (links.length === 0) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", "README has no external links to check.");
    return;
  }

  const deadChecks = await Promise.all(
    links.map(async (l) => ({ ...l, dead: await isLinkDead(l.url) }))
  );
  const deadLinks = deadChecks.filter((l) => l.dead);

  if (deadLinks.length === 0) {
    await recordFinding(env, repo, "link_health", "reported_only", "low", `All ${links.length} link(s) healthy.`);
    return;
  }

  const deadList = deadLinks.map((l) => `${l.text}: ${l.url}`).join("; ");

  // Locked tiers: report only, no fix regardless of agent.
  if (locked) {
    await recordFinding(
      env, repo, "dead_link_fix", "reported_only", "high",
      `${deadLinks.length} dead link(s): ${deadList}. Tier-locked — no automated fix.`
    );
    await auditEvent(env, agent.agent_id, agent.model_line, "GATE_FAILED", repo.name, repo.tier,
      `Tier-lock gate: ${deadLinks.length} dead link(s) not fixed.`, workPacketId);
    return;
  }

  // lippytmai-brand is allowed only to report, not write (no open_pr / commit).
  if (!agentCanDo(agent, "open_pr")) {
    await recordFinding(
      env, repo, "dead_link_fix", "escalated", "medium",
      `${deadLinks.length} dead link(s) found by ${agent.agent_id}: ${deadList}. Agent not permitted to open PRs.`
    );
    await auditEvent(env, agent.agent_id, agent.model_line, "ESCALATED", repo.name, repo.tier,
      `Agent ${agent.agent_id} escalated — prohibited from open_pr.`, workPacketId);
    return;
  }

  // lippytm-builder: attempt AI fix + draft PR.
  const fixed = await draftLinkFix(env.ANTHROPIC_API_KEY, readme.content, deadLinks);
  if (!fixed) {
    await recordFinding(
      env, repo, "dead_link_fix", "escalated", "medium",
      `${deadLinks.length} dead link(s): ${deadList}. No ANTHROPIC_API_KEY or draft failed.`
    );
    return;
  }

  if (!env.GITHUB_TOKEN) {
    await recordFinding(
      env, repo, "dead_link_fix", "escalated", "medium",
      `AI fix drafted for ${deadLinks.length} dead link(s) but GITHUB_TOKEN not set.`
    );
    return;
  }

  const branch = `hermes-link-fix-${new Date().toISOString().slice(0, 10)}`;
  const branchOk = await createBranch(ORG, repo.name, branch, "main", env.GITHUB_TOKEN);
  if (!branchOk) {
    await recordFinding(env, repo, "dead_link_fix", "escalated", "medium", "AI fix drafted but branch creation failed.");
    return;
  }

  const updateOk = await updateFile(
    ORG, repo.name, "README.md", branch, fixed, readme.sha,
    `hermes(${agent.agent_id}): fix ${deadLinks.length} dead link(s) in README`,
    env.GITHUB_TOKEN
  );
  if (!updateOk) {
    await recordFinding(env, repo, "dead_link_fix", "escalated", "medium", "AI fix drafted but commit to branch failed.");
    return;
  }

  const prUrl = await openDraftPR(
    ORG, repo.name, branch, "main",
    `Hermes(${agent.agent_id}): fix ${deadLinks.length} dead link(s) in README`,
    `Automated by the Hermes swarm agent \`${agent.agent_id}\` (${scheduleLabel}).\n\nDead links: ${deadList}\n\nWork packet: \`${workPacketId}\`\n\nThis is a **draft PR** — Hermes never auto-merges. Review before merging.`,
    env.GITHUB_TOKEN
  );

  const prStatus: Status = prUrl ? "pr_opened_pending_review" : "escalated";
  await recordFinding(
    env, repo, "dead_link_fix", prStatus, "medium",
    prUrl ? `Draft PR opened by ${agent.agent_id}.` : "Fix committed but PR creation failed.",
    prUrl
  );
  const prAuditType: AuditEventType = prUrl ? "PR_OPENED" : "ESCALATED";
  await auditEvent(env, agent.agent_id, agent.model_line, prAuditType, repo.name, repo.tier,
    prUrl ? `Draft PR: ${prUrl}` : "PR creation failed after commit.", workPacketId);
}

// ── Lippy Killjoy: red-team / adversarial audit ────────────────────────────

async function runRedTeamAudit(
  env: Env,
  agent: SwarmPassport,
  repo: ManifestRepo,
  scheduleLabel: string,
  workPacketId: string
): Promise<void> {
  // 1. Oversized issue backlog check (> 20 open issues = flag).
  const issueCount = await getOpenIssueCount(ORG, repo.name, env.GITHUB_TOKEN);
  if (issueCount !== null && issueCount > 20) {
    const desc = `[RED-TEAM] Oversized issue backlog: ${issueCount} open issues in ${repo.name} at ${scheduleLabel}.`;
    await recordFinding(env, repo, "identity_audit", "escalated", "high", desc);
    await auditEvent(env, agent.agent_id, agent.model_line, "ESCALATED", repo.name, repo.tier, desc, workPacketId);
  }

  // 2. README identity misuse surface check (looks for unguarded clone-persona claims).
  const readme = await getFile(ORG, repo.name, "README.md", env.GITHUB_TOKEN);
  if (readme) {
    const suspectPatterns = [
      /charles earl lipshay.*literally/i,
      /actual alien/i,
      /shape.?shift/i,
      /time.?travel(?!ler|ing bot|machine)/i,
      /quantum.?immortal/i,
    ];
    const hits = suspectPatterns.filter((re) => re.test(readme.content));
    if (hits.length > 0) {
      const desc = `[RED-TEAM] Potential identity-boundary violation in ${repo.name} README: ${hits.length} suspect pattern(s). Manual review required.`;
      await recordFinding(env, repo, "identity_audit", "escalated", "high", desc);
      await auditEvent(env, agent.agent_id, agent.model_line, "GATE_FAILED", repo.name, repo.tier, desc, workPacketId);
    } else {
      const desc = `[RED-TEAM] No identity-boundary violations detected in ${repo.name} README.`;
      await recordFinding(env, repo, "identity_audit", "reported_only", "low", desc);
      await auditEvent(env, agent.agent_id, agent.model_line, "FINDING_RECORDED", repo.name, repo.tier, desc, workPacketId);
    }
  }
}

// ── Swarm dispatch ─────────────────────────────────────────────────────────

interface AgentResult {
  agent_id: string;
  repos_processed: number;
  repos_skipped_claim: number;
  repos_skipped_tier: number;
}

async function runAgentAcrossFleet(
  env: Env,
  agent: SwarmPassport,
  repos: ManifestRepo[],
  scheduleLabel: string
): Promise<AgentResult> {
  let processed = 0;
  let skippedClaim = 0;
  let skippedTier = 0;

  const workPacketId = `WP-${agent.agent_id.toUpperCase()}-${Date.now()}`;

  await auditEvent(env, agent.agent_id, agent.model_line, "AGENT_DISPATCHED",
    "fleet", "fleet", `Agent ${agent.agent_id} dispatched for ${scheduleLabel}. Work packet: ${workPacketId}`, workPacketId);

  for (const repo of repos) {
    // Skip deprioritized repos always.
    if (repo.tier === "deprioritized") continue;

    // Skip if tier not in agent's permitted_tiers.
    if (!agent.permitted_tiers.includes(repo.tier)) {
      skippedTier++;
      await auditEvent(env, agent.agent_id, agent.model_line, "AGENT_SKIPPED_TIER",
        repo.name, repo.tier, `Agent ${agent.agent_id} not permitted on tier ${repo.tier}.`, workPacketId);
      continue;
    }

    // Attempt to acquire claim; skip if another agent holds it.
    const claimId = await claimRepoForAgent(env, agent, repo.name);
    if (claimId === null) {
      skippedClaim++;
      await recordFinding(env, repo, "swarm_coordination", "reported_only", "low",
        `Agent ${agent.agent_id} skipped ${repo.name} — another active claim exists.`);
      await auditEvent(env, agent.agent_id, agent.model_line, "REPO_CLAIM_BLOCKED",
        repo.name, repo.tier, `Claim blocked for ${agent.agent_id}.`, workPacketId);
      continue;
    }

    await auditEvent(env, agent.agent_id, agent.model_line, "REPO_CLAIM_ACQUIRED",
      repo.name, repo.tier, `Claim ${claimId} acquired.`, workPacketId);

    try {
      await triageRepoForAgent(env, agent, repo, scheduleLabel, workPacketId);
      processed++;
    } finally {
      await releaseClaimForAgent(env, claimId);
      await auditEvent(env, agent.agent_id, agent.model_line, "REPO_CLAIM_RELEASED",
        repo.name, repo.tier, `Claim ${claimId} released.`, workPacketId);
    }
  }

  await auditEvent(env, agent.agent_id, agent.model_line, "SWARM_COMPLETED",
    "fleet", "fleet",
    `Agent ${agent.agent_id} completed. processed=${processed} skipped_claim=${skippedClaim} skipped_tier=${skippedTier}`,
    workPacketId);

  return { agent_id: agent.agent_id, repos_processed: processed, repos_skipped_claim: skippedClaim, repos_skipped_tier: skippedTier };
}

async function dispatchSwarm(env: Env, scheduleLabel: string): Promise<AgentResult[]> {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
  const repos = parseManifest(await res.text());

  // Filter active (non-expired) agents.
  const activeAgents = SWARM_AGENTS.filter((a) => !isAgentExpired(a));

  // Fan out all agents concurrently.
  const results = await Promise.all(
    activeAgents.map((agent) => runAgentAcrossFleet(env, agent, repos, scheduleLabel))
  );

  if (env.SLACK_WEBHOOK_URL) {
    const summary = results
      .map((r) => `• \`${r.agent_id}\`: ${r.repos_processed} processed, ${r.repos_skipped_claim} claim-blocked, ${r.repos_skipped_tier} tier-skipped`)
      .join("\n");
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*Hermes swarm (${scheduleLabel}) completed:*\n${summary}` }),
    }).catch(() => {});
  }

  return results;
}

function scheduleLabelForCron(cron: string): string {
  switch (cron) {
    case "0 6 * * *": return "nightly_scan";
    case "0 7 * * 1": return "deep_audit";
    case "0 5 * * *": return "self_heal";
    case "0 8 * * 1": return "weekly_link_health";
    default:          return "unscheduled_scan";
  }
}

// ── Auth helper (shared with v3 claims endpoints) ──────────────────────────

function checkAuth(request: Request, env: Env): boolean {
  if (!env.ZO_SHARED_SECRET) return false;
  return request.headers.get("X-Hermes-Secret") === env.ZO_SHARED_SECRET;
}

// ── v3 claim endpoint handlers (preserved) ────────────────────────────────

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
    return Response.json({ error: "Required fields: repo_name, claimed_by, action_type" }, { status: 400 });
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

// ── v4 swarm endpoint handlers ─────────────────────────────────────────────

async function handleSwarmStatus(env: Env): Promise<Response> {
  // Per-agent: last audit event timestamp + total findings + active claim count.
  const rows = await Promise.all(
    SWARM_AGENTS.map(async (agent) => {
      const lastRun = await env.HERMES_DB.prepare(
        `SELECT created_at FROM hermes_audit_events
         WHERE agent_id = ? AND event_type = 'SWARM_COMPLETED'
         ORDER BY created_at DESC LIMIT 1`
      )
        .bind(agent.agent_id)
        .first<{ created_at: string }>();

      const findingCount = await env.HERMES_DB.prepare(
        `SELECT COUNT(*) as cnt FROM hermes_findings`
      ).first<{ cnt: number }>();

      const activeClaims = await env.HERMES_DB.prepare(
        `SELECT COUNT(*) as cnt FROM system_claims WHERE claimed_by = ? AND released_at IS NULL`
      )
        .bind(agent.agent_id)
        .first<{ cnt: number }>();

      return {
        agent_id: agent.agent_id,
        display_name: agent.display_name,
        model_line: agent.model_line,
        permitted_tiers: agent.permitted_tiers,
        expired: isAgentExpired(agent),
        last_swarm_completed: lastRun?.created_at ?? null,
        total_findings: findingCount?.cnt ?? 0,
        active_claims: activeClaims?.cnt ?? 0,
      };
    })
  );
  return Response.json({ swarm_agents: rows });
}

async function handleSwarmAudit(env: Env, url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo");
  const agent = url.searchParams.get("agent");

  let query = `SELECT id, agent_id, model_line, event_type, repo_name, repo_tier, detail, work_packet_id, created_at
               FROM hermes_audit_events WHERE 1=1`;
  const binds: string[] = [];

  if (repo) { query += ` AND repo_name = ?`; binds.push(repo); }
  if (agent) { query += ` AND agent_id = ?`; binds.push(agent); }
  query += ` ORDER BY created_at DESC LIMIT 100`;

  const stmt = env.HERMES_DB.prepare(query);
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
  return Response.json({ filters: { repo, agent }, events: results });
}

async function handleSwarmDispatch(request: Request, env: Env): Promise<Response> {
  if (!checkAuth(request, env)) {
    return Response.json({ error: "Unauthorized. Set X-Hermes-Secret header." }, { status: 401 });
  }
  const body: any = await request.json().catch(() => ({}));
  const label: string = body?.label ?? "manual_swarm_dispatch";
  const results = await dispatchSwarm(env, label);
  return Response.json({ ok: true, label, agents: results });
}

// ── Worker export ──────────────────────────────────────────────────────────

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchSwarm(env, scheduleLabelForCron(event.cron)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Legacy single-agent scan (backwards-compat with v2/v3 callers).
    if (url.pathname === "/run") {
      const label = url.searchParams.get("type") || "manual_scan";
      const results = await dispatchSwarm(env, label);
      return Response.json({ ok: true, label, agents: results });
    }

    if (url.pathname === "/findings") {
      const { results } = await env.HERMES_DB.prepare(
        "SELECT * FROM hermes_findings ORDER BY detected_at DESC LIMIT 50"
      ).all();
      return Response.json(results);
    }

    // v3 claims endpoints.
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

    // v4 swarm endpoints.
    if (url.pathname === "/swarm/status" && request.method === "GET") {
      return handleSwarmStatus(env);
    }

    if (url.pathname === "/swarm/audit" && request.method === "GET") {
      return handleSwarmAudit(env, url);
    }

    if (url.pathname === "/swarm/dispatch" && request.method === "POST") {
      return handleSwarmDispatch(request, env);
    }

    return new Response(
      "Hermes engine v4 (swarm fabric). Endpoints:\n" +
      "  GET  /run?type=<label>          — legacy scan (triggers full swarm)\n" +
      "  GET  /findings                  — recent findings\n" +
      "  GET  /claims?repo=<name>        — active claims for a repo\n" +
      "  POST /claim                     — register external claim (X-Hermes-Secret)\n" +
      "  POST /claim/release             — release claim (X-Hermes-Secret)\n" +
      "  GET  /swarm/status              — all agents' status\n" +
      "  GET  /swarm/audit?repo=X&agent=Y — audit event log\n" +
      "  POST /swarm/dispatch            — trigger swarm manually (X-Hermes-Secret)\n",
      { status: 200 }
    );
  },
};
