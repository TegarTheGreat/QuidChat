import type { IncomingMessage, ServerResponse } from "node:http"
import {
  createCannedAnswer,
  deleteCannedAnswer,
  listCannedAnswers,
  setCannedAnswerStatus,
} from "./admin/canned-answers.js"
import { deleteChannel, listChannels, putChannel } from "./admin/channels.js"
import {
  getConversation,
  listConversations,
  listEscalations,
  resolveEscalation,
} from "./admin/conversations.js"
import { getSetup, getUsage } from "./admin/insights.js"
import { getSettings, patchSettings } from "./admin/settings.js"
import { sendJson, type AdminDeps } from "./admin/shared.js"
import {
  createRoutingRule,
  createSkill,
  getSkills,
  linkSkillSource,
} from "./admin/skills.js"
import {
  createTextSource,
  createUrlSource,
  deleteSource,
  listSources,
} from "./admin/sources.js"
import { createOrUpdateTenant, listTenants } from "./admin/tenants.js"

/**
 * The admin API's front door: authenticate, then dispatch.
 *
 * The handlers live in `./admin/`, one module per thing an owner manages. They were all in
 * this file until it passed a thousand lines, at which point the routing table — the part
 * anyone opens this file to read — was buried in the middle of twenty handlers.
 */

export type { AdminDeps }

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
  if (method === "POST" && sub === "/sources/url") return createUrlSource(req, res, deps)
  if (method === "DELETE" && sub === "/sources") return deleteSource(req, res, deps)
  if (method === "GET" && sub === "/conversations") return listConversations(res, deps, searchParams)
  if (method === "GET" && sub === "/conversation") return getConversation(res, deps, searchParams)
  if (method === "GET" && sub === "/escalations") return listEscalations(res, deps, searchParams)
  if (method === "POST" && sub === "/escalations/resolve") return resolveEscalation(req, res, deps)
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
  if (method === "GET" && sub === "/channels") return listChannels(res, deps, searchParams)
  if (method === "PUT" && sub === "/channels") return putChannel(req, res, deps)
  if (method === "DELETE" && sub === "/channels") return deleteChannel(req, res, deps)

  sendJson(res, 404, { error: "not found" })
}
