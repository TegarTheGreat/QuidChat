import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { sql } from "drizzle-orm"
import { readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

/**
 * `GET /admin/skills?tenantSlug=…` — skills with their linked sources and routing rules.
 *
 * Returned together rather than as three calls, because they are only meaningful together:
 * a skill with no rule is unreachable, and a rule pointing at a disabled skill is skipped.
 * An owner debugging why a question went to the wrong place needs to see all three at once.
 */
export async function getSkills(
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
export async function createSkill(
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
export async function linkSkillSource(
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
export async function createRoutingRule(
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
