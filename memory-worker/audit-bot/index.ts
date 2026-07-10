/**
 * memory-audit-bot
 * Nightly integrity check over D1: lippytm-swarms-memory (ai_clone_identity /
 * ai_clone_interactions). Writes findings into the EXISTING hermes_findings table
 * in D1: hermes-findings (id 88ca2414-372e-4542-926e-8ea6c9d7c6c7).
 *
 * Status is ALWAYS 'reported_only'. This bot never writes, deletes, or fixes
 * memory rows itself -- it only detects and reports.
 *
 * Bindings expected in wrangler.toml:
 *   MEMORY_DB    -> lippytm-swarms-memory (4867c86f-2897-4082-9ad5-a10d3b1048b1)
 *   FINDINGS_DB  -> hermes-findings        (88ca2414-372e-4542-926e-8ea6c9d7c6c7)
 *
 * Checks: stale_unverified, orphaned_supersede, duplicate_active, unconfirmed_guardrail.
 * Run modes: cron (scheduled), or GET /run for an on-demand manual run.
 */

export interface Env {
  MEMORY_DB: D1Database;
  FINDINGS_DB: D1Database;
}

type Finding = {
  finding_type: string;
  risk_level: "low" | "medium" | "high";
  description: string;
};

const REPO_NAME = "lippytm-swarms-memory";
const REPO_TIER = "governance";

async function checkStaleUnverified(env: Env): Promise<Finding[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.MEMORY_DB.prepare(
    `SELECT id, category, key, updated_at FROM ai_clone_identity
     WHERE confidence = 'unverified' AND superseded_by IS NULL AND updated_at < ?`
  )
    .bind(thirtyDaysAgo)
    .all<any>();

  return rows.results.map((r) => ({
    finding_type: "stale_unverified",
    risk_level: "low" as const,
    description: `Row id=${r.id} (category=${r.category}, key=${r.key}) has been 'unverified' since ${r.updated_at} with no promotion to 'confirmed'.`,
  }));
}

async function checkOrphanedSupersede(env: Env): Promise<Finding[]> {
  const rows = await env.MEMORY_DB.prepare(
    `SELECT a.id, a.superseded_by FROM ai_clone_identity a
     WHERE a.superseded_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ai_clone_identity b WHERE b.id = a.superseded_by)`
  ).all<any>();

  return rows.results.map((r) => ({
    finding_type: "orphaned_supersede",
    risk_level: "high" as const,
    description: `Row id=${r.id} has superseded_by=${r.superseded_by}, which does not exist. Possible bad migration or manual delete.`,
  }));
}

async function checkDuplicateActive(env: Env): Promise<Finding[]> {
  const rows = await env.MEMORY_DB.prepare(
    `SELECT category, key, COUNT(*) as n FROM ai_clone_identity
     WHERE superseded_by IS NULL
     GROUP BY category, key HAVING COUNT(*) > 1`
  ).all<any>();

  return rows.results.map((r) => ({
    finding_type: "duplicate_active",
    risk_level: "medium" as const,
    description: `category=${r.category}, key=${r.key} has ${r.n} simultaneously-active (non-superseded) rows. Likely a write that bypassed the Memory Worker's conflict handling.`,
  }));
}

async function checkUnconfirmedGuardrail(env: Env): Promise<Finding[]> {
  const rows = await env.MEMORY_DB.prepare(
    `SELECT id, key, confidence FROM ai_clone_identity
     WHERE category = 'guardrail' AND superseded_by IS NULL AND confidence != 'confirmed'`
  ).all<any>();

  return rows.results.map((r) => ({
    finding_type: "unconfirmed_guardrail",
    risk_level: "high" as const,
    description: `Guardrail row id=${r.id} (key=${r.key}) has confidence='${r.confidence}', not 'confirmed'. Guardrail-tier facts must always be confirmed.`,
  }));
}

async function writeFindings(env: Env, findings: Finding[]): Promise<number> {
  for (const f of findings) {
    await env.FINDINGS_DB.prepare(
      `INSERT INTO hermes_findings (repo_name, repo_tier, finding_type, risk_level, status, description)
       VALUES (?, ?, ?, ?, 'reported_only', ?)`
    )
      .bind(REPO_NAME, REPO_TIER, f.finding_type, f.risk_level, f.description)
      .run();
  }
  return findings.length;
}

async function runAudit(env: Env): Promise<{ total: number; by_type: Record<string, number> }> {
  const [stale, orphaned, duplicates, unconfirmedGuardrails] = await Promise.all([
    checkStaleUnverified(env),
    checkOrphanedSupersede(env),
    checkDuplicateActive(env),
    checkUnconfirmedGuardrail(env),
  ]);

  const all = [...stale, ...orphaned, ...duplicates, ...unconfirmedGuardrails];
  await writeFindings(env, all);

  const byType: Record<string, number> = {};
  for (const f of all) byType[f.finding_type] = (byType[f.finding_type] ?? 0) + 1;

  return { total: all.length, by_type: byType };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const summary = await runAudit(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("memory-audit-bot. GET /run to trigger an on-demand audit.", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAudit(env));
  },
};
