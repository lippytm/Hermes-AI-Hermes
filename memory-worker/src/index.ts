/**
 * Memory Worker -- validated read/write API in front of D1: lippytm-swarms-memory
 * Gives the AI Agnostic Clone Engine Fabric one consistent memory bus that any
 * system (Hermes bots, Claude sessions, ChatGPT bridge, Gemini bridge, Zo Space)
 * reads/writes through, instead of each system holding its own siloed state.
 *
 * Bindings expected in wrangler.toml:
 *   [[d1_databases]]
 *   binding = "MEMORY_DB"
 *   database_name = "lippytm-swarms-memory"
 *   database_id = "4867c86f-2897-4082-9ad5-a10d3b1048b1"
 *
 * Schema (already migrated live):
 *   ai_clone_identity(id, category, key, value, source, updated_at,
 *                      confidence, writer_system, version, superseded_by,
 *                      requires_human_confirmation)
 *   ai_clone_interactions(id, interface_name, interaction_summary, created_at,
 *                          writer_system, confidence)
 *
 * Endpoints:
 *   GET  /memory?category=&key=          -> read (latest, non-superseded rows only)
 *   POST /memory                          -> write with validation + versioning
 *   GET  /interactions?interface_name=    -> read interaction log
 *   POST /interactions                    -> write interaction log entry
 *
 * Write contract for POST /memory (JSON body):
 *   { category, key, value, source, writer_system, confidence?, confirmed_by_human? }
 *
 * Validation rules (integrity gate):
 *   1. category, key, value, source, writer_system are REQUIRED. Missing any -> 400.
 *   2. If a row with the same (category, key) already exists:
 *        - if new value === existing value -> no-op, return existing row (idempotent)
 *        - if new value differs -> the OLD row is marked superseded_by = new row id,
 *          the NEW row gets version = old.version + 1. Nothing is silently overwritten;
 *          full history is preserved via superseded_by chain.
 *   3. If category = 'guardrail' (or any row previously flagged
 *      requires_human_confirmation = 1 for that category/key), the write is REJECTED
 *      with 409 unless the request includes "confirmed_by_human": true.
 *      This is the integrity gate -- guardrail-tier facts cannot be silently changed
 *      by an AI system, only by an explicit human-confirmed call.
 *   4. confidence defaults to 'unverified' unless explicitly set. Only writes tagged
 *      confidence = 'confirmed' should be treated as ground truth by downstream readers;
 *      'unverified' rows are visible but should be treated as provisional.
 *   5. Every write is attributed: writer_system is mandatory, no anonymous writes.
 *      This is what makes conflict detection and the future memory-audit-bot possible --
 *      you can't audit trust you didn't record.
 *
 * The memory-audit-bot (next build step) reads this same D1 database nightly and
 * writes its findings into the existing hermes_findings table (D1: hermes-findings,
 * id 88ca2414-372e-4542-926e-8ea6c9d7c6c7) -- NOT a separate QA system -- checking for:
 *   - conflicting 'confirmed' facts under the same category/key
 *   - stale entries (updated_at older than a threshold with no re-confirmation)
 *   - orphaned superseded_by chains
 *   - unverified rows older than N days that were never promoted to confirmed
 */

export interface Env {
  MEMORY_DB: D1Database;
}

const REQUIRED_WRITE_FIELDS = ["category", "key", "value", "source", "writer_system"] as const;

type MemoryWriteBody = {
  category: string;
  key: string;
  value: string;
  source: string;
  writer_system: string;
  confidence?: string;
  confirmed_by_human?: boolean;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validateWriteBody(body: Partial<MemoryWriteBody>): string | null {
  for (const field of REQUIRED_WRITE_FIELDS) {
    if (!body[field] || typeof body[field] !== "string" || body[field]!.trim() === "") {
      return `Missing or empty required field: "${field}". Required: ${REQUIRED_WRITE_FIELDS.join(", ")}.`;
    }
  }
  return null;
}

async function handleMemoryGet(url: URL, env: Env): Promise<Response> {
  const category = url.searchParams.get("category");
  const key = url.searchParams.get("key");

  let query = "SELECT * FROM ai_clone_identity WHERE superseded_by IS NULL";
  const binds: string[] = [];

  if (category) {
    query += " AND category = ?";
    binds.push(category);
  }
  if (key) {
    query += " AND key = ?";
    binds.push(key);
  }
  query += " ORDER BY updated_at DESC";

  const stmt = env.MEMORY_DB.prepare(query).bind(...binds);
  const result = await stmt.all();
  return jsonResponse({ results: result.results, count: result.results.length });
}

async function handleMemoryPost(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Partial<MemoryWriteBody> | null;
  if (!body) return jsonResponse({ error: "Invalid or missing JSON body." }, 400);

  const validationError = validateWriteBody(body);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  const { category, key, value, source, writer_system } = body as MemoryWriteBody;
  const confidence = body.confidence ?? "unverified";
  const confirmedByHuman = body.confirmed_by_human === true;

  // Look up existing non-superseded row for this category/key
  const existing = await env.MEMORY_DB.prepare(
    "SELECT * FROM ai_clone_identity WHERE category = ? AND key = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 1"
  )
    .bind(category, key)
    .first<any>();

  // Integrity gate: guardrail-tier or previously-flagged facts require explicit human confirmation to change
  if (existing && existing.requires_human_confirmation === 1 && existing.value !== value && !confirmedByHuman) {
    return jsonResponse(
      {
        error:
          "This category/key is flagged requires_human_confirmation. The write was rejected. " +
          'Resubmit with "confirmed_by_human": true only if a human has explicitly approved this change.',
        existing_value: existing.value,
        attempted_value: value,
      },
      409
    );
  }

  // Idempotent no-op if the value hasn't actually changed
  if (existing && existing.value === value) {
    return jsonResponse({ status: "no_op", reason: "value unchanged", row: existing });
  }

  const now = new Date().toISOString();
  const nextVersion = existing ? (existing.version ?? 1) + 1 : 1;
  const requiresConfirmation = existing ? existing.requires_human_confirmation : category === "guardrail" ? 1 : 0;

  const insertResult = await env.MEMORY_DB.prepare(
    `INSERT INTO ai_clone_identity
      (category, key, value, source, updated_at, confidence, writer_system, version, requires_human_confirmation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(category, key, value, source, now, confidence, writer_system, nextVersion, requiresConfirmation)
    .run();

  const newId = insertResult.meta.last_row_id;

  // Preserve history: mark the old row as superseded rather than deleting/overwriting it
  if (existing) {
    await env.MEMORY_DB.prepare("UPDATE ai_clone_identity SET superseded_by = ? WHERE id = ?")
      .bind(newId, existing.id)
      .run();
  }

  return jsonResponse({ status: "written", id: newId, version: nextVersion, superseded: existing ? existing.id : null }, 201);
}

async function handleInteractionsGet(url: URL, env: Env): Promise<Response> {
  const interfaceName = url.searchParams.get("interface_name");
  let query = "SELECT * FROM ai_clone_interactions";
  const binds: string[] = [];
  if (interfaceName) {
    query += " WHERE interface_name = ?";
    binds.push(interfaceName);
  }
  query += " ORDER BY created_at DESC LIMIT 200";
  const result = await env.MEMORY_DB.prepare(query).bind(...binds).all();
  return jsonResponse({ results: result.results, count: result.results.length });
}

async function handleInteractionsPost(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  if (!body || !body.interface_name || !body.interaction_summary || !body.writer_system) {
    return jsonResponse(
      { error: "Required fields: interface_name, interaction_summary, writer_system." },
      400
    );
  }
  const now = new Date().toISOString();
  const confidence = body.confidence ?? "unverified";
  const result = await env.MEMORY_DB.prepare(
    `INSERT INTO ai_clone_interactions (interface_name, interaction_summary, created_at, writer_system, confidence)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.interface_name, body.interaction_summary, now, body.writer_system, confidence)
    .run();
  return jsonResponse({ status: "written", id: result.meta.last_row_id }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/memory" && request.method === "GET") {
        return await handleMemoryGet(url, env);
      }
      if (url.pathname === "/memory" && request.method === "POST") {
        return await handleMemoryPost(request, env);
      }
      if (url.pathname === "/interactions" && request.method === "GET") {
        return await handleInteractionsGet(url, env);
      }
      if (url.pathname === "/interactions" && request.method === "POST") {
        return await handleInteractionsPost(request, env);
      }
      return jsonResponse({ error: "Not found. Endpoints: GET/POST /memory, GET/POST /interactions." }, 404);
    } catch (err) {
      return jsonResponse({ error: "Internal error", detail: String(err) }, 500);
    }
  },
};
