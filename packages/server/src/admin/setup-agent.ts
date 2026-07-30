import {
  describeAction,
  runSetupTurn,
  GATED_TOOLS,
  type SetupExecutor,
  type SetupToolResult,
  type ToolCall,
} from "@quidchat/core"
import type { IncomingMessage, ServerResponse } from "node:http"
import { collectSetupSnapshot } from "../setup-status.js"
import { readJsonBody, type AdminDeps } from "./shared.js"

/**
 * `POST /admin/setup/chat` — one turn with the setup assistant.
 *
 * The confirmation gate lives in two places on purpose. The agent refuses to execute a gated call
 * and hands it back for a person to approve; this route then refuses it a second time when the
 * panel sends it back without `confirmed: true`. A gate enforced only where the model runs would
 * be bypassed by anything that can reach this endpoint — and this endpoint is reachable with an
 * admin token, which is exactly the credential an owner would paste into something else.
 */

async function chatModelFor(deps: AdminDeps, tenantId: string): Promise<string> {
  const config = await deps.store.getTenantConfig(tenantId)
  return config.chatModel
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/** Builds the executor for one tenant. Every tool is scoped to that tenant by construction —
 *  no tool takes a tenant argument, so the model cannot name someone else's. */
function executorFor(deps: AdminDeps, tenantId: string, hasProvider: boolean): SetupExecutor {
  return async (call: ToolCall): Promise<SetupToolResult> => {
    switch (call.name) {
      case "run_diagnostics": {
        const snapshot = await collectSetupSnapshot({ db: deps.db, tenantId, hasProvider })
        const { adviseSetup } = await import("@quidchat/core")
        const findings = adviseSetup(snapshot)
        if (findings.length === 0) return { ok: true, detail: "Nothing is blocking answers." }
        return {
          ok: true,
          detail: findings.map((f) => `${f.title} — ${f.why} Fix: ${f.fix}`).join("\n"),
        }
      }
      case "list_knowledge_sources": {
        const snapshot = await collectSetupSnapshot({ db: deps.db, tenantId, hasProvider })
        return {
          ok: true,
          detail: `${snapshot.sourceCount} source(s), ${snapshot.chunkCount} indexed chunk(s).`,
        }
      }
      // The rest are not wired yet. Saying so is the honest answer: a tool that silently does
      // nothing and reports success would have the assistant tell an owner their document is
      // indexed when it is not.
      default:
        return {
          ok: false,
          error: `${call.name} is not available in this build — do it from the panel instead.`,
        }
    }
  }
}

export async function postSetupChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (!body) return

  const tenantId = typeof body.tenantId === "string" ? body.tenantId : null
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!tenantId || message === "") {
    sendJson(res, 400, { error: "tenantId and message are required" })
    return
  }
  // A confirmed action arrives as its own request, carrying the call the owner approved.
  const confirming = body.confirm as { call?: ToolCall; confirmed?: boolean } | undefined
  if (confirming?.call) {
    if (confirming.confirmed !== true) {
      sendJson(res, 400, { error: "that action needs an explicit confirmation" })
      return
    }
    const execute = executorFor(deps, tenantId, true)
    const outcome = await execute(confirming.call)
    sendJson(res, 200, {
      kind: "reply",
      text: outcome.ok ? outcome.detail : `That did not work — ${outcome.error}`,
      ran: [confirming.call.name],
    })
    return
  }

  const history = Array.isArray(body.history)
    ? (body.history as { role: "user" | "assistant"; content: string }[]).slice(-10)
    : []

  const turn = await runSetupTurn({
    provider: deps.provider,
    // The tenant's own chat model, so the setup assistant costs what the owner already chose.
    model: await chatModelFor(deps, tenantId),
    history,
    message,
    execute: executorFor(deps, tenantId, true),
  })

  if (turn.kind === "needs_confirmation") {
    sendJson(res, 200, {
      kind: "needs_confirmation",
      text: turn.text,
      ran: turn.ran,
      pending: { call: turn.pending.call, summary: turn.pending.summary },
    })
    return
  }
  sendJson(res, 200, { kind: "reply", text: turn.text, ran: turn.ran })
}

/** Exported so a test can assert the route's own gate, not just the agent's. */
export function requiresConfirmation(call: ToolCall): boolean {
  return GATED_TOOLS.has(call.name)
}

export { describeAction }
