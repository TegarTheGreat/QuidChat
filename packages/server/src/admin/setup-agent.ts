import {
  describeAction,
  runSetupTurn,
  GATED_TOOLS,
  SETUP_TOOLS,
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

/**
 * What this build can actually do.
 *
 * The model used to be handed all ten tool definitions while the executor implemented two, so it
 * would offer to create a skill, call the tool, and then have to explain to the owner why the
 * thing it had just offered did not happen. Offering exactly what runs removes a whole class of
 * that — and the test beside this file asserts the two lists cannot drift apart.
 */
const IMPLEMENTED = new Set(["run_diagnostics", "list_knowledge_sources", "explain_setting"])

export const OFFERED_SETUP_TOOLS = SETUP_TOOLS.filter((tool) => IMPLEMENTED.has(tool.name))

/**
 * What each setting does, in the words the panel uses.
 *
 * Written here rather than left to the model's memory, which is the point of the tool: a model
 * recalling "retention_days" from its training describes some other product's setting, and an
 * owner acts on the description.
 */
const SETTING_NOTES: Record<string, string> = {
  answer_mode:
    "How an answer is produced. `static` uses only approved canned answers and refuses anything " +
    "else, which costs nothing per question. `thrifty` searches your documents and writes from " +
    "them. `full` also rewrites the question first, which finds more but costs more.",
  chat_model: "The model that writes answers. Changing it changes cost and quality, nothing else.",
  embedding_model:
    "The model that turns your documents into searchable vectors. Changing it means every " +
    "document has to be indexed again — vectors from two models cannot be compared, so a " +
    "half-changed library searches worse than either.",
  refusal_text:
    "What a customer reads when the documents do not cover their question. It is sent word for " +
    "word, so write it as your business would say it.",
  escalation_mode: "What happens when the assistant gives up: record it only, or notify you.",
  escalation_target: "Where a notification goes — a webhook address you control.",
  monthly_budget_cents:
    "The most this assistant may spend on the provider in a calendar month. Reaching it stops " +
    "answers rather than running up a bill. Zero means no limit at all, which is not the same " +
    "as zero spending.",
  retention_days:
    "How long transcripts are kept before they are deleted automatically. It does not answer a " +
    "customer asking you to erase theirs today — the Conversations screen does that.",
  high_risk_topics:
    "Subjects the assistant must never answer from inference: price, discounts, warranty, " +
    "refunds, legal terms, stock. It answers on these only from a document that says so plainly.",
  allowed_origins:
    "The websites allowed to open your widget. A site not listed is refused, which is what stops " +
    "someone else embedding your assistant and spending your budget.",
  max_handoffs_per_turn: "How many times skills may pass one question along before answering it.",
  max_handoffs_per_conversation: "The same limit, across a whole conversation.",
  widget_theme:
    "The widget's look: colour, side of the screen, title, language, greeting and the questions " +
    "offered on the opening screen.",
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
      case "explain_setting": {
        const name = typeof call.input.name === "string" ? call.input.name.trim() : ""
        // Both spellings, because an owner says "monthly budget" and the model passes it through.
        const key = name.toLowerCase().replace(/[\s-]+/g, "_")
        const note = SETTING_NOTES[key]
        if (!note) {
          return {
            ok: false,
            error: `there is no setting called ${name || "that"}. The settings are: ${Object.keys(SETTING_NOTES).join(", ")}.`,
          }
        }
        return { ok: true, detail: `${key}: ${note}` }
      }
      // Anything else is not offered to the model at all — see OFFERED_SETUP_TOOLS. This stays
      // as the answer for a confirmed action arriving from an older panel, where saying so
      // honestly beats a tool that silently does nothing and reports success.
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
    tools: OFFERED_SETUP_TOOLS,
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

/**
 * The tenant-scoped executor, for tests.
 *
 * Only the tools that need no database are reachable through it — `explain_setting` is answered
 * from the notes above and nothing else. A fake `deps` is enough for exactly that, which is the
 * point: the explanation must not depend on anything but this build.
 */
export function executorForTest(): SetupExecutor {
  return executorFor({ db: null } as unknown as AdminDeps, "test-tenant", true)
}
