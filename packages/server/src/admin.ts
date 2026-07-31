import { timingSafeEqual } from "node:crypto"
import { clientAddress, trustedProxyHops } from "./client-address.js"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  createCannedAnswer,
  deleteCannedAnswer,
  listCannedAnswers,
  setCannedAnswerStatus,
  updateCannedAnswer,
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
import {
  deleteProviders,
  getProviderModels,
  getProviders,
  putProviders,
} from "./admin/providers.js"
import { postSetupChat } from "./admin/setup-agent.js"
import { sendJson, type AdminDeps } from "./admin/shared.js"
import {
  createRoutingRule,
  createSkill,
  deleteRoutingRule,
  deleteSkill,
  getSkills,
  linkSkillSource,
  updateSkill,
} from "./admin/skills.js"
import {
  createTextSource,
  createUrlSource,
  deleteSource,
  reindexSource,
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
/**
 * Compares two secrets without leaking where they first differ.
 *
 * `===` on strings stops at the first differing byte, so how long it takes is a function of how
 * much of the token an attacker already has. That is a slow attack over a network and a real one
 * on a shared host, and the channel adapters in this codebase already verify their signatures
 * this way — leaving the admin token as the one exception would be an odd place to draw the line.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch. Length is not the
 * secret; the bytes are.
 */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function checkAdminAuth(req: IncomingMessage, adminToken: string | undefined): AuthResult {
  if (adminToken === undefined) {
    return {
      ok: false,
      status: 503,
      error: "QUIDCHAT_ADMIN_TOKEN must be set in the environment to enable the admin API",
    }
  }
  const presented = req.headers.authorization ?? ""
  if (!secretsMatch(presented, `Bearer ${adminToken}`)) {
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
    // Only FAILED attempts are counted, so the panel — which makes many authenticated requests
    // per screen — is never throttled. The token is chosen by whoever deploys this, and some of
    // them will choose badly; a few hundred guesses an hour is not an attack worth mounting.
    if (auth.status === 401 && deps.failedAuthLimiter) {
      // Proxy-aware for the same reason as the chat limiter: one shared bucket means an
      // attacker's wrong guesses lock out the real administrator.
      const source = clientAddress(req, trustedProxyHops(deps.env ?? process.env))
      const decision = deps.failedAuthLimiter.check(source)
      if (!decision.allowed) {
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(decision.retryAfterSeconds),
        })
        res.end(JSON.stringify({ error: "too many failed attempts" }))
        return
      }
    }
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
  if (method === "POST" && sub === "/sources/reindex") return reindexSource(req, res, deps)
  if (method === "DELETE" && sub === "/sources") return deleteSource(req, res, deps)
  if (method === "GET" && sub === "/conversations") return listConversations(res, deps, searchParams)
  if (method === "GET" && sub === "/conversation") return getConversation(res, deps, searchParams)
  if (method === "GET" && sub === "/escalations") return listEscalations(res, deps, searchParams)
  if (method === "POST" && sub === "/escalations/resolve") return resolveEscalation(req, res, deps)
  if (method === "GET" && sub === "/usage") return getUsage(res, deps, searchParams)
  if (method === "GET" && sub === "/providers/models") return getProviderModels(res, deps, searchParams)
  if (method === "GET" && sub === "/providers") return getProviders(res, deps, searchParams)
  if (method === "PUT" && sub === "/providers") return putProviders(req, res, deps)
  if (method === "DELETE" && sub === "/providers") return deleteProviders(req, res, deps)
  if (method === "GET" && sub === "/setup") return getSetup(res, deps, searchParams)
  if (method === "POST" && sub === "/setup/chat") return postSetupChat(req, res, deps)
  if (method === "GET" && sub === "/skills") return getSkills(res, deps, searchParams)
  if (method === "POST" && sub === "/skills") return createSkill(req, res, deps)
  if (method === "POST" && sub === "/skills/sources") return linkSkillSource(req, res, deps)
  if (method === "POST" && sub === "/routing-rules") return createRoutingRule(req, res, deps)
  if (method === "DELETE" && sub === "/routing-rules") return deleteRoutingRule(req, res, deps)
  if (method === "PATCH" && sub === "/skills") return updateSkill(req, res, deps)
  if (method === "DELETE" && sub === "/skills") return deleteSkill(req, res, deps)
  if (method === "GET" && sub === "/canned-answers") return listCannedAnswers(res, deps, searchParams)
  if (method === "POST" && sub === "/canned-answers") return createCannedAnswer(req, res, deps)
  if (method === "POST" && sub === "/canned-answers/status") return setCannedAnswerStatus(req, res, deps)
  if (method === "PATCH" && sub === "/canned-answers") return updateCannedAnswer(req, res, deps)
  if (method === "DELETE" && sub === "/canned-answers") return deleteCannedAnswer(req, res, deps)
  if (method === "GET" && sub === "/channels") return listChannels(res, deps, searchParams)
  if (method === "PUT" && sub === "/channels") return putChannel(req, res, deps)
  if (method === "DELETE" && sub === "/channels") return deleteChannel(req, res, deps)

  sendJson(res, 404, { error: "not found" })
}
