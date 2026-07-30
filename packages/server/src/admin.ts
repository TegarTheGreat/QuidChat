import type { IncomingMessage, ServerResponse } from "node:http"
import type { Provider, Store } from "@quidchat/core"
import { withTenant, type QuidDb } from "@quidchat/db"
import { indexSource } from "@quidchat/ingest"
import { sql, type SQL } from "drizzle-orm"
import { setupStatus } from "./setup-status.js"
import { lookupTenantBySlug } from "./tenant-lookup.js"

/** Normalizes the `execute()` result, whose shape differs between drivers — see the
 *  identical helper in `chat.ts`, `tenant-lookup.ts`, `budget.ts`, and `@quidchat/db`'s
 *  `store.ts`. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/**
 * Admin bodies can carry pasted knowledge-base text (`POST /admin/sources/text`), which
 * is routinely far larger than a chat message — `chat.ts`'s 16 KiB bound would reject a
 * perfectly normal support article. Still bounded, though: an unbounded read is a
 * denial-of-service that requires no attacker skill at all — see `chat.ts`'s
 * `readBoundedBody`, which this mirrors.
 */
const MAX_ADMIN_BODY_BYTES = 4 * 1024 * 1024

async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_ADMIN_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

/** Reads and JSON-parses a request body, sending the appropriate `400` and returning
 *  `undefined` itself on every failure so callers can just check for `undefined`. */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const contentType = req.headers["content-type"] ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    sendJson(res, 400, { error: "expected application/json" })
    return undefined
  }
  const raw = await readBoundedBody(req)
  if (raw === null) {
    sendJson(res, 400, { error: "request body too large" })
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" })
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) {
    sendJson(res, 400, { error: "expected a JSON object body" })
    return undefined
  }
  return parsed as Record<string, unknown>
}

/**
 * Renders a JS string array as a Postgres array literal, passed as a BIND parameter and
 * cast with `::text[]` at the call site — copied from `packages/cli/src/init.ts`'s
 * `pgTextArray`, which explains why: passing the array directly as a bind parameter
 * flattens it to a single scalar, so a `text[]` column receives one string and the
 * insert fails. Quotes are escaped because these values are operator- or
 * business-owner-supplied.
 */
function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`
}

export type AdminDeps = {
  db: QuidDb
  store: Store
  provider: Provider
  logError: (message: string, cause: unknown) => void
  /** `undefined` exactly when `QUIDCHAT_ADMIN_TOKEN` is not set in the environment —
   *  every admin route then refuses with `503` rather than defaulting to open. */
  adminToken: string | undefined
}

type AuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string }

/**
 * PLACEHOLDER admin gate — one shared bearer token, not a real session.
 *
 * It answers "is this caller allowed to reach the admin API at all", not "which admin
 * is this": no identity, no per-user permissions, no expiry beyond the process's own
 * environment. Real admin sessions (the `admin_users` / `admin_sessions` tables already
 * exist in the schema for exactly that) are the admin-panel plan's responsibility, not
 * this one. Written down here in plain terms so this gate is not mistaken for the real
 * thing and quietly left in place — a temporary gate nobody writes down becomes
 * permanent.
 *
 * An unset `QUIDCHAT_ADMIN_TOKEN` is `503`, never a silent "allow everything": refusing
 * to start the admin API beats defaulting to open. It is also never compared as a
 * possibly-empty string against a possibly-empty header — that comparison would let a
 * blank token match a blank (absent) header, which is exactly the failure this
 * `=== undefined` check exists to rule out.
 */
function checkAdminAuth(req: IncomingMessage, adminToken: string | undefined): AuthResult {
  if (adminToken === undefined) {
    return {
      ok: false,
      status: 503,
      error: "QUIDCHAT_ADMIN_TOKEN must be set in the environment to enable the admin API",
    }
  }
  if (req.headers.authorization !== `Bearer ${adminToken}`) {
    return { ok: false, status: 401, error: "missing or invalid admin token" }
  }
  return { ok: true }
}

/** Resolves `slug` to a tenant id via the same public lookup `/chat` uses, sending the
 *  appropriate `400`/`404` and returning `null` itself on every failure. Deliberately
 *  NOT a bypass of its own: this reuses the one documented cross-tenant lookup rather
 *  than adding a second. */
async function resolveTenantOr404(
  res: ServerResponse,
  db: QuidDb,
  slug: string | null,
): Promise<string | null> {
  if (!slug) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return null
  }
  const identity = await lookupTenantBySlug(db, slug)
  if (!identity) {
    sendJson(res, 404, { error: "unknown tenant" })
    return null
  }
  return identity.tenantId
}

/** Cross-tenant: every tenant's slug, name, and id, for the admin panel's tenant
 *  picker. Uses the raw `db` handle, not `withTenant` — there is no single tenant
 *  context to scope this under. `tenants` carries RLS (policy `tenant_self`), so this
 *  is the second documented bypass the spec calls for, alongside `lookupTenantBySlug`. */
async function listTenants(res: ServerResponse, deps: AdminDeps): Promise<void> {
  const result = await deps.db.execute(sql`SELECT id, slug, name FROM tenants ORDER BY slug`)
  const list = rowsOf(result).map((r) => ({ id: r.id, slug: r.slug, name: r.name }))
  sendJson(res, 200, { tenants: list })
}

/**
 * Creates a tenant (and its settings row) or updates an existing one's name and
 * allowed origins. Idempotent on `slug`, same as `packages/cli/src/init.ts`'s
 * `initTenant` — an operator or the admin panel re-submitting a form should not have
 * to know whether the tenant already exists.
 *
 * Uses the raw `db` handle rather than `withTenant`, and has to: the `tenant_self` RLS
 * policy scopes to `id = current_tenant_id()`, so inserting a brand-new tenant id can
 * never satisfy it — there is no tenant context to set before the row exists. This IS
 * "the admin routes' own tenant resolution" the spec carves out as a second documented
 * bypass, mirroring `initTenant`'s reasoning exactly.
 */
async function createOrUpdateTenant(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { slug, name, origins } = body
  if (typeof slug !== "string" || slug.length === 0) {
    sendJson(res, 400, { error: "slug is required" })
    return
  }
  if (typeof name !== "string" || name.length === 0) {
    sendJson(res, 400, { error: "name is required" })
    return
  }
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === "string")) {
    sendJson(res, 400, { error: "origins must be an array of strings" })
    return
  }

  const existing = rowsOf(
    await deps.db.execute(sql`SELECT id FROM tenants WHERE slug = ${slug}`),
  )[0]

  if (existing) {
    const tenantId = existing.id as string
    await deps.db.execute(sql`UPDATE tenants SET name = ${name} WHERE id = ${tenantId}`)
    await deps.db.execute(sql`
      UPDATE tenant_settings SET allowed_origins = ${pgTextArray(origins)}::text[] WHERE tenant_id = ${tenantId}
    `)
    sendJson(res, 200, { id: tenantId, slug, name, created: false })
    return
  }

  const inserted = rowsOf(
    await deps.db.execute(sql`INSERT INTO tenants (slug, name) VALUES (${slug}, ${name}) RETURNING id`),
  )[0]!
  const tenantId = inserted.id as string
  // Every other column has a default, so this row exists purely to make the tenant
  // configurable — see the identical note in `initTenant`.
  await deps.db.execute(sql`
    INSERT INTO tenant_settings (tenant_id, allowed_origins) VALUES (${tenantId}, ${pgTextArray(origins)}::text[])
  `)
  sendJson(res, 201, { id: tenantId, slug, name, created: true })
}

async function getSettings(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const row = await withTenant(deps.db, tenantId, async (tx) => {
    // No `WHERE tenant_id` — RLS does the scoping, same as every other read in
    // `@quidchat/db`'s `store.ts`.
    const result = await tx.execute(sql`SELECT * FROM tenant_settings`)
    return rowsOf(result)[0]
  })
  if (!row) {
    sendJson(res, 404, { error: "tenant settings not found" })
    return
  }
  sendJson(res, 200, row)
}

/**
 * An explicit ALLOWLIST of writable `tenant_settings` columns, not a denylist — a
 * future column added to the table is simply not writable through this route until it
 * is deliberately added here, rather than being writable by accident the moment it
 * exists.
 */
const SETTINGS_COLUMNS = new Set([
  "answer_mode", "chat_model", "rewrite_model", "embedding_model", "refusal_text", "escalation_mode",
  "escalation_target", "monthly_budget_cents", "retention_days", "high_risk_topics",
  "allowed_origins", "widget_theme", "max_handoffs_per_turn", "max_handoffs_per_conversation",
])

/** The two `text[]` columns in the allowlist above — see `pgTextArray`. */
const ARRAY_SETTINGS_COLUMNS = new Set(["high_risk_topics", "allowed_origins"])

async function patchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { tenantSlug, ...fields } = body
  if (typeof tenantSlug !== "string" || tenantSlug.length === 0) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }

  const keys = Object.keys(fields)
  if (keys.length === 0) {
    sendJson(res, 400, { error: "no settings fields provided" })
    return
  }
  const unknownKeys = keys.filter((k) => !SETTINGS_COLUMNS.has(k))
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { error: `unknown settings field(s): ${unknownKeys.join(", ")}` })
    return
  }

  const tenantId = await resolveTenantOr404(res, deps.db, tenantSlug)
  if (tenantId === null) return

  const setClauses: SQL[] = []
  for (const key of keys) {
    const value = fields[key]
    if (ARRAY_SETTINGS_COLUMNS.has(key)) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        sendJson(res, 400, { error: `${key} must be an array of strings` })
        return
      }
      // `key` is only ever one of the hardcoded literals in `SETTINGS_COLUMNS` at this
      // point — checked above — so `sql.raw` on it is not user-controlled SQL text.
      setClauses.push(sql`${sql.raw(key)} = ${pgTextArray(value)}::text[]`)
    } else if (key === "answer_mode") {
      // Constrained in SQL, so an invalid value would come back as a database error written
      // for an operator. This is also the single most consequential setting a business owner
      // can change — `static` stops calling the model entirely — so a typo silently becoming
      // a 500 is the wrong outcome.
      if (typeof value !== "string" || !["static", "thrifty", "full"].includes(value)) {
        sendJson(res, 400, { error: "answer_mode must be static, thrifty or full" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${value}`)
    } else if (key === "widget_theme") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        sendJson(res, 400, { error: "widget_theme must be an object" })
        return
      }
      setClauses.push(sql`${sql.raw(key)} = ${JSON.stringify(value)}::jsonb`)
    } else {
      setClauses.push(sql`${sql.raw(key)} = ${value}`)
    }
  }

  const row = await withTenant(deps.db, tenantId, async (tx) => {
    await tx.execute(sql`UPDATE tenant_settings SET ${sql.join(setClauses, sql`, `)}`)
    const result = await tx.execute(sql`SELECT * FROM tenant_settings`)
    return rowsOf(result)[0]
  })
  sendJson(res, 200, row)
}

async function listSources(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, kind, uri, status, error, last_indexed_at
      FROM knowledge_sources
      ORDER BY last_indexed_at DESC NULLS LAST, id
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    sources: rows.map((r) => ({
      id: r.id, kind: r.kind, uri: r.uri, status: r.status, error: r.error,
      lastIndexedAt: r.last_indexed_at,
    })),
  })
}

/**
 * Creates a `text` knowledge source and indexes it immediately, so its content is
 * retrievable through `/chat` as soon as this call returns — that round trip is the
 * whole point of this route, not a side effect of it.
 *
 * The source row is inserted through `withTenant` first (`status: "pending"`), then
 * `indexSource` (from `@quidchat/ingest`) takes it through `"indexing"` to `"ready"` or
 * `"error"`. An embedding failure there is `indexSource`'s own documented, asymmetric
 * failure contract — chunks are still written (findable by keyword, even with no
 * vector) and the row is left `status: "error"` with the message — so it is answered
 * here as a normal `201`, not a `500`: nothing about this request itself failed, and
 * the source row already carries the failure for the admin panel to show.
 */
async function createTextSource(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { tenantSlug, title, text } = body
  if (typeof tenantSlug !== "string" || tenantSlug.length === 0) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }
  if (typeof title !== "string" || title.length === 0) {
    sendJson(res, 400, { error: "title is required" })
    return
  }
  if (typeof text !== "string" || text.length === 0) {
    sendJson(res, 400, { error: "text is required" })
    return
  }

  const tenantId = await resolveTenantOr404(res, deps.db, tenantSlug)
  if (tenantId === null) return

  const { embeddingModel } = await deps.store.getTenantConfig(tenantId)

  const sourceId = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${title}, 'pending')
      RETURNING id
    `)
    return rowsOf(result)[0]!.id as string
  })

  try {
    const indexed = await indexSource({
      tenantId, sourceId, title, text, embeddingModel, store: deps.store, provider: deps.provider,
    })
    sendJson(res, 201, {
      sourceId, documentId: indexed.documentId, chunkCount: indexed.chunkCount, status: "ready",
    })
  } catch (e) {
    // Worth an operational log even though the visitor-facing (here, admin-facing)
    // response stays clean — an embedding provider failing is something an operator
    // should notice, not just something a business owner eventually spots on the
    // sources list.
    deps.logError("indexSource failed for a text source", e)
    const message = e instanceof Error ? e.message : String(e)
    sendJson(res, 201, { sourceId, status: "error", error: message })
  }
}

async function listConversations(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT c.id, c.channel, c.visitor_id, c.status, c.created_at,
             count(m.id)::int AS message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    conversations: rows.map((r) => ({
      id: r.id, channel: r.channel, visitorId: r.visitor_id, status: r.status,
      createdAt: r.created_at, messageCount: r.message_count,
    })),
  })
}

async function listEscalations(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    // `escalations.occurred_at` exists now, so this orders by the moment the escalation
    // actually happened rather than by its parent conversation — which was exact for a
    // conversation with one escalation and wrong for one with several. This list is what
    // an owner reads to decide what content to write next, and the wrong order sends them
    // to the oldest gap first.
    //
    // The question text is joined in as well: a reason alone says the bot could not
    // answer, while the question says what to write.
    const result = await tx.execute(sql`
      SELECT e.id, e.reason, e.resolved_at, e.occurred_at, e.conversation_id,
             (
               SELECT m.content FROM messages m
               WHERE m.conversation_id = e.conversation_id AND m.role = 'user'
               ORDER BY m.created_at DESC
               LIMIT 1
             ) AS question
      FROM escalations e
      ORDER BY e.occurred_at DESC, e.id DESC
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    escalations: rows.map((r) => ({
      id: r.id, reason: r.reason, conversationId: r.conversation_id,
      resolvedAt: r.resolved_at, occurredAt: r.occurred_at, question: r.question,
    })),
  })
}

async function getUsage(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const row = await withTenant(deps.db, tenantId, async (tx) => {
    // Mirrors `budget.ts`'s `spentThisMonthCents`, but broken out by token direction
    // rather than collapsed to a single cost figure — this is what the admin panel
    // shows a business owner, not what `chat.ts` compares against a budget.
    const result = await tx.execute(sql`
      SELECT COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(cost_cents), 0)::bigint AS cost_cents
      FROM usage_events
      WHERE created_at >= date_trunc('month', now())
    `)
    return rowsOf(result)[0]!
  })
  sendJson(res, 200, {
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costCents: Number(row.cost_cents),
  })
}

/**
 * Dispatches every `/admin/...` route (already stripped of any `/v1` prefix by the
 * caller — see `server.ts`). Every route requires `Authorization: Bearer <token>`
 * against `QUIDCHAT_ADMIN_TOKEN`, checked here, once, BEFORE any body is read or any
 * query runs — see `checkAdminAuth`.
 *
 * Scoping is by an explicit `tenantSlug` in the query (`GET`) or body (`POST`/`PATCH`),
 * resolved with the same `lookupTenantBySlug` the public `/chat` route uses — not the
 * origin-allowlist path, which exists for visitors, not operators.
 */
/**
 * `GET /admin/setup?tenantSlug=…`
 *
 * What is stopping this tenant from answering, and what to do about it.
 *
 * A first-time owner has a technically valid installation that answers nothing, because
 * there is no content and no allowed origin, and nothing else in the product tells them
 * that. The advice is pure inspection — no model is involved — so this works in static
 * mode and with no provider configured, which is exactly when an owner most needs to be
 * told what is wrong.
 */
async function getSetup(
  res: ServerResponse,
  deps: AdminDeps,
  searchParams: URLSearchParams,
): Promise<void> {
  const tenantSlug = searchParams.get("tenantSlug")
  if (!tenantSlug) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }
  const identity = await lookupTenantBySlug(deps.db, tenantSlug)
  if (!identity) {
    sendJson(res, 404, { error: "unknown tenant" })
    return
  }
  const status = await setupStatus({
    db: deps.db,
    tenantId: identity.tenantId,
    // The server was handed a provider at construction, so this is already known —
    // re-deriving it from the environment could disagree with what is actually wired.
    hasProvider: true,
  })
  sendJson(res, 200, status)
}

/**
 * `GET /admin/skills?tenantSlug=…` — skills with their linked sources and routing rules.
 *
 * Returned together rather than as three calls, because they are only meaningful together:
 * a skill with no rule is unreachable, and a rule pointing at a disabled skill is skipped.
 * An owner debugging why a question went to the wrong place needs to see all three at once.
 */
async function getSkills(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const payload = await withTenant(deps.db, tenantId, async (tx) => {
    const skills = rowsOf(
      await tx.execute(sql`
        SELECT id, name, description, system_prompt, enabled, is_fallback, answer_mode
        FROM skills ORDER BY name
      `),
    )
    const rules = rowsOf(
      await tx.execute(sql`
        SELECT id, skill_id, position, kind, pattern, enabled
        FROM routing_rules ORDER BY position
      `),
    )
    const links = rowsOf(
      await tx.execute(sql`
        SELECT ss.skill_id, ss.source_id, ks.uri
        FROM skill_sources ss JOIN knowledge_sources ks ON ks.id = ss.source_id
      `),
    )
    return { skills, rules, links }
  })

  sendJson(res, 200, {
    skills: payload.skills.map((r) => ({
      id: r.id, name: r.name, description: r.description,
      systemPrompt: r.system_prompt, enabled: r.enabled,
      isFallback: r.is_fallback, answerMode: r.answer_mode,
      sources: payload.links
        .filter((l) => l.skill_id === r.id)
        .map((l) => ({ sourceId: l.source_id, uri: l.uri })),
    })),
    rules: payload.rules.map((r) => ({
      id: r.id, skillId: r.skill_id, position: Number(r.position),
      kind: r.kind, pattern: r.pattern, enabled: r.enabled,
    })),
  })
}

/** `POST /admin/skills` — create a skill. */
async function createSkill(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : null,
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : null,
    isFallback: raw.isFallback === true,
    answerMode: typeof raw.answerMode === "string" ? raw.answerMode : null,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (body.name.trim() === "") {
    sendJson(res, 400, { error: "name is required" })
    return
  }
  // `answer_mode` is constrained in SQL, so an invalid value would surface as a database
  // error with a message meant for an operator. Rejecting it here gives the panel
  // something it can show a user.
  if (body.answerMode && !["static", "thrifty", "full"].includes(body.answerMode)) {
    sendJson(res, 400, { error: "answerMode must be static, thrifty or full" })
    return
  }

  const created = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO skills (tenant_id, name, description, system_prompt, is_fallback, answer_mode)
      VALUES (
        ${tenantId}, ${body.name}, ${body.description},
        ${body.systemPrompt}, ${body.isFallback}, ${body.answerMode}
      )
      RETURNING id, name
    `)
    return rowsOf(result)[0]
  })
  sendJson(res, 201, { skill: created })
}

/** `POST /admin/skills/sources` — link or unlink a source. */
async function linkSkillSource(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    skillId: typeof raw.skillId === "string" ? raw.skillId : "",
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : "",
    linked: raw.linked !== false,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.skillId || !body.sourceId) {
    sendJson(res, 400, { error: "skillId and sourceId are required" })
    return
  }

  await withTenant(deps.db, tenantId, async (tx) => {
    if (!body.linked) {
      await tx.execute(sql`
        DELETE FROM skill_sources
        WHERE skill_id = ${body.skillId} AND source_id = ${body.sourceId}
      `)
      return
    }
    // Idempotent: an owner clicking twice should not get a primary-key error.
    await tx.execute(sql`
      INSERT INTO skill_sources (tenant_id, skill_id, source_id)
      VALUES (${tenantId}, ${body.skillId}, ${body.sourceId})
      ON CONFLICT (skill_id, source_id) DO NOTHING
    `)
  })
  sendJson(res, 200, { ok: true })
}

/** `POST /admin/routing-rules` — create a routing rule. */
async function createRoutingRule(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    skillId: typeof raw.skillId === "string" ? raw.skillId : "",
    position: typeof raw.position === "number" ? raw.position : null,
    kind: typeof raw.kind === "string" ? raw.kind : "",
    pattern: typeof raw.pattern === "string" ? raw.pattern : null,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.skillId) {
    sendJson(res, 400, { error: "skillId is required" })
    return
  }
  if (!body.kind || !["keyword", "semantic", "llm", "fallback"].includes(body.kind)) {
    sendJson(res, 400, { error: "kind must be keyword, semantic, llm or fallback" })
    return
  }
  // A keyword rule with no pattern matches nothing, so it would sit in the list looking
  // configured while doing nothing at all.
  if (body.kind === "keyword" && (!body.pattern || body.pattern.trim() === "")) {
    sendJson(res, 400, { error: "a keyword rule needs a pattern" })
    return
  }

  const created = await withTenant(deps.db, tenantId, async (tx) => {
    // Appended at the end by default. Position decides evaluation order and first match
    // wins, so silently inserting at the front would change how existing rules behave.
    const next = body.position ?? Number(
      rowsOf(await tx.execute(sql`
        SELECT coalesce(max(position), 0) + 1 AS next FROM routing_rules
      `))[0]!.next,
    )
    const result = await tx.execute(sql`
      INSERT INTO routing_rules (tenant_id, skill_id, position, kind, pattern)
      VALUES (${tenantId}, ${body.skillId}, ${next}, ${body.kind}, ${body.pattern})
      RETURNING id, position
    `)
    return rowsOf(result)[0]
  })
  sendJson(res, 201, { rule: created })
}

/** One shape for a canned answer on every route. The list route mapping `created_at` to
 *  `createdAt` while `RETURNING` handed back the raw column was a difference the panel's
 *  types could not see and would have shown as an empty date after a create. */
function cannedAnswerPayload(row: Record<string, unknown>) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    createdAt: row.created_at,
  }
}

/**
 * `GET /admin/canned-answers` — every canned answer, drafts included.
 *
 * Drafts are returned alongside approved rows deliberately: a draft is invisible to
 * matching, so the only place an owner can ever see one is here. Filtering them out would
 * make an AI-proposed answer unreviewable, and review is the entire point of the draft
 * state.
 */
async function listCannedAnswers(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        SELECT id, question, answer, status, created_at
        FROM canned_answers
        -- Drafts first: they are the ones waiting on a human, and an owner opening this
        -- screen is here to clear that queue.
        ORDER BY (status = 'draft') DESC, created_at DESC
      `),
    ),
  )

  sendJson(res, 200, { cannedAnswers: rows.map(cannedAnswerPayload) })
}

/**
 * `POST /admin/canned-answers` — add one.
 *
 * Created as a draft unless `approved: true` is sent explicitly. A person typing an answer
 * into the panel is that human review, so the panel does send it; the default stays `draft`
 * so that any other caller — a future AI suggestion, an import — cannot put text in front of
 * a customer without someone saying so.
 */
async function createCannedAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    question: typeof raw.question === "string" ? raw.question : "",
    answer: typeof raw.answer === "string" ? raw.answer : "",
    approved: raw.approved === true,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (body.question.trim() === "" || body.answer.trim() === "") {
    sendJson(res, 400, { error: "question and answer are both required" })
    return
  }

  const created = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO canned_answers (tenant_id, question, answer, status)
      VALUES (
        ${tenantId}, ${body.question.trim()}, ${body.answer.trim()},
        ${body.approved ? "approved" : "draft"}
      )
      RETURNING id, question, answer, status, created_at
    `)
    return rowsOf(result)[0]!
  })
  sendJson(res, 201, { cannedAnswer: cannedAnswerPayload(created) })
}

/**
 * `POST /admin/canned-answers/status` — approve or send back to draft.
 *
 * A separate route from creation, and the only way a row becomes live. Approval is what
 * makes `static` mode trustworthy for price and warranty questions: every answer a customer
 * can receive was read by a person first. Un-approving is the same route, because taking a
 * wrong answer down has to be as easy as putting it up.
 */
async function setCannedAnswerStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
    approved: raw.approved === true,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const updated = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
        UPDATE canned_answers
        SET status = ${body.approved ? "approved" : "draft"}
        WHERE id = ${body.id}
        RETURNING id, status
      `),
    )[0],
  )
  // An id belonging to another tenant is invisible under RLS, so it lands here as "not
  // found" rather than as a successful no-op — which is the honest answer, and the same one
  // an id that genuinely does not exist gets.
  if (!updated) {
    sendJson(res, 404, { error: "canned answer not found" })
    return
  }
  sendJson(res, 200, { cannedAnswer: updated })
}

/** `DELETE /admin/canned-answers` — remove one. */
async function deleteCannedAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const deleted = await withTenant(deps.db, tenantId, async (tx) =>
    rowsOf(await tx.execute(sql`DELETE FROM canned_answers WHERE id = ${body.id} RETURNING id`))[0],
  )
  if (!deleted) {
    sendJson(res, 404, { error: "canned answer not found" })
    return
  }
  sendJson(res, 200, { ok: true })
}

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  deps: AdminDeps,
): Promise<void> {
  const auth = checkAdminAuth(req, deps.adminToken)
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error })
    return
  }

  const sub = pathname.slice("/admin".length) || "/"
  const method = req.method ?? "GET"

  if (method === "GET" && sub === "/tenants") return listTenants(res, deps)
  if (method === "POST" && sub === "/tenants") return createOrUpdateTenant(req, res, deps)
  if (method === "GET" && sub === "/settings") return getSettings(res, deps, searchParams)
  if (method === "PATCH" && sub === "/settings") return patchSettings(req, res, deps)
  if (method === "GET" && sub === "/sources") return listSources(res, deps, searchParams)
  if (method === "POST" && sub === "/sources/text") return createTextSource(req, res, deps)
  if (method === "GET" && sub === "/conversations") return listConversations(res, deps, searchParams)
  if (method === "GET" && sub === "/escalations") return listEscalations(res, deps, searchParams)
  if (method === "GET" && sub === "/usage") return getUsage(res, deps, searchParams)
  if (method === "GET" && sub === "/setup") return getSetup(res, deps, searchParams)
  if (method === "GET" && sub === "/skills") return getSkills(res, deps, searchParams)
  if (method === "POST" && sub === "/skills") return createSkill(req, res, deps)
  if (method === "POST" && sub === "/skills/sources") return linkSkillSource(req, res, deps)
  if (method === "POST" && sub === "/routing-rules") return createRoutingRule(req, res, deps)
  if (method === "GET" && sub === "/canned-answers") return listCannedAnswers(res, deps, searchParams)
  if (method === "POST" && sub === "/canned-answers") return createCannedAnswer(req, res, deps)
  if (method === "POST" && sub === "/canned-answers/status") return setCannedAnswerStatus(req, res, deps)
  if (method === "DELETE" && sub === "/canned-answers") return deleteCannedAnswer(req, res, deps)

  sendJson(res, 404, { error: "not found" })
}
