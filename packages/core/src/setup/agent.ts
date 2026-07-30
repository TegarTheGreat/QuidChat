import type { Provider, ToolCall, ToolDefinition } from "../provider.js"

/**
 * The setup assistant: an agent the business owner talks to inside the admin panel.
 *
 * It is the mirror image of the customer-facing assistant, and the differences are deliberate.
 * The customer-facing one answers strangers about a business, so every claim about that business
 * must carry a citation. This one answers the owner about their own QuidChat, so it needs to
 * explain, suggest and disagree — forcing it to cite a document per sentence would make it
 * useless. The grounding validator is therefore **not** run on its replies.
 *
 * What replaces that safeguard is the confirmation gate. The assistant can propose freely and act
 * on anything reversible, but four actions change what customers see or what the business is
 * billed, and those stop and wait for a human. The split between `generate_canned_answers` and
 * `approve_canned_answers` is the clearest case: it can draft a hundred answers at no risk,
 * because a draft is invisible to matching until a person approves it.
 */

/** Tools whose effect a person must confirm before it happens. */
export const GATED_TOOLS = new Set([
  // The moment AI-written text becomes something a customer can be shown.
  "approve_canned_answers",
  // Removes indexed material. The answers that depended on it start refusing.
  "delete_knowledge_source",
  // Every existing embedding was produced by the old model, so this re-indexes everything and
  // bills for it. Vectors from two models are not comparable, so a partial re-index is worse
  // than none.
  "set_embedding_model",
  // Spends the business's money, and a wrong key looks identical to an outage.
  "set_provider_credential",
])

export const SETUP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_knowledge_sources",
    description: "List the documents and pages this assistant can answer from.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_diagnostics",
    description:
      "Check the assistant's setup and report anything stopping it from answering — no provider, " +
      "no documents, an exhausted budget, repeated refusals.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "explain_setting",
    description:
      "Explain what one setting does and what changes if the owner changes it. Use this instead " +
      "of answering from memory, so the explanation matches this version of QuidChat.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The setting's name." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "test_flow",
    description:
      "Ask the customer-facing assistant a question exactly as a visitor would, and report the " +
      "answer, which skill handled it, and which documents it cited.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "add_knowledge_source",
    description: "Index a page or a block of text so the assistant can answer from it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        url: { type: "string", description: "A page to fetch. Omit when supplying text." },
        text: { type: "string", description: "Text to index directly. Omit when supplying a url." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "create_skill",
    description:
      "Create a skill: a persona with its own instructions and its own slice of the documents.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        systemPrompt: { type: "string", description: "How this skill should speak and what it covers." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "set_routing_rule",
    description:
      "Send messages matching a keyword to a skill. Rules are evaluated in order and the first " +
      "match wins, so position matters.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string" },
        keyword: { type: "string" },
        position: { type: "integer", minimum: 1 },
      },
      required: ["skillName", "keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_canned_answers",
    description:
      "Draft fixed answers for common questions. Drafts are never shown to a customer — a person " +
      "has to approve them first — so propose freely.",
    parameters: {
      type: "object",
      properties: { questions: { type: "array", items: { type: "string" } } },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "approve_canned_answers",
    description:
      "Make drafted answers live to customers. Needs the owner's confirmation, because this is " +
      "the point where AI-written text starts being shown as the business's own words.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_knowledge_source",
    description: "Remove an indexed document. Questions it answered will start being refused.",
    parameters: {
      type: "object",
      properties: { sourceId: { type: "string" } },
      required: ["sourceId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_embedding_model",
    description:
      "Change the model used for search. This re-indexes every document, which takes time and " +
      "costs money — vectors from two models cannot be compared, so it is all or nothing.",
    parameters: {
      type: "object",
      properties: { model: { type: "string" } },
      required: ["model"],
      additionalProperties: false,
    },
  },
  {
    name: "set_provider_credential",
    description: "Set the API key the assistant uses to answer.",
    parameters: {
      type: "object",
      properties: { provider: { type: "string" }, apiKey: { type: "string" } },
      required: ["provider", "apiKey"],
      additionalProperties: false,
    },
  },
]

export type SetupToolResult = { ok: true; detail: string } | { ok: false; error: string }

/** Runs one tool. Supplied by the server, which owns the admin operations and the tenant scope. */
export type SetupExecutor = (call: ToolCall) => Promise<SetupToolResult>

export type PendingAction = {
  call: ToolCall
  /** What the owner is being asked to allow, in their words. */
  summary: string
}

export type SetupTurn =
  | { kind: "reply"; text: string; ran: string[] }
  | { kind: "needs_confirmation"; text: string; pending: PendingAction; ran: string[] }

/** Plain sentences, because this is what a person reads before clicking Allow. */
export function describeAction(call: ToolCall): string {
  const input = call.input
  switch (call.name) {
    case "approve_canned_answers": {
      const count = Array.isArray(input.ids) ? input.ids.length : 0
      return `Publish ${count} drafted answer(s) so customers start seeing them.`
    }
    case "delete_knowledge_source":
      return `Delete the document "${String(input.sourceId ?? "")}". Questions it answered will be refused.`
    case "set_embedding_model":
      return `Switch search to "${String(input.model ?? "")}" and re-index every document. This costs money and takes time.`
    case "set_provider_credential":
      return `Set the API key for ${String(input.provider ?? "the provider")}. It will be used for every answer, and billed to you.`
    default:
      return `Run ${call.name}.`
  }
}

/** How many times the model may call tools before it has to say something. */
const MAX_TOOL_ROUNDS = 4

const SYSTEM = [
  "You help a business owner set up their QuidChat assistant.",
  "",
  "Use the tools rather than answering from memory: run_diagnostics before guessing why",
  "something is not working, explain_setting rather than recalling what a setting does, and",
  "test_flow to show what a customer would actually receive.",
  "",
  "Four actions stop and ask the owner first — approving answers, deleting a document, changing",
  "the search model, and setting an API key. Call them normally when they are the right thing to",
  "do; the panel handles the asking. Do not ask for permission in prose and then not call the",
  "tool, because nothing happens if you do that.",
  "",
  "Reply as JSON: {\"segments\":[{\"kind\":\"general\",\"text\":\"...\"}]}. Say what you did and what",
  "you found. Be concrete and brief.",
].join("\n")

/**
 * One turn of the setup conversation.
 *
 * Returns as soon as a gated tool comes back — the call is NOT executed. The panel shows it to
 * the owner, and only their approval sends it to the executor. Anything ungated runs immediately
 * and its result goes back to the model, so it can chain a diagnosis into a fix.
 */
export async function runSetupTurn(args: {
  provider: Provider
  model: string
  history: { role: "user" | "assistant"; content: string }[]
  message: string
  execute: SetupExecutor
}): Promise<SetupTurn> {
  const ran: string[] = []
  const history = [...args.history]
  let currentTurn = args.message

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await args.provider.complete({
      model: args.model,
      prompt: { system: SYSTEM, history, currentTurn },
      tools: [...SETUP_TOOLS],
    })

    const calls = result.toolCalls ?? []
    if (calls.length === 0) {
      const text = (result.answer?.segments ?? []).map((s) => s.text).join("\n").trim()
      return { kind: "reply", text, ran }
    }

    const gated = calls.find((c) => GATED_TOOLS.has(c.name))
    if (gated) {
      // Deliberately before running any other call in this batch. A model that asks to delete a
      // document and re-index in one turn must not have the re-index happen while the owner is
      // still deciding about the deletion.
      const text = (result.answer?.segments ?? []).map((s) => s.text).join("\n").trim()
      return {
        kind: "needs_confirmation",
        text,
        pending: { call: gated, summary: describeAction(gated) },
        ran,
      }
    }

    const results: string[] = []
    for (const call of calls) {
      const outcome = await args.execute(call)
      ran.push(call.name)
      results.push(`${call.name}: ${outcome.ok ? outcome.detail : `failed — ${outcome.error}`}`)
    }

    history.push({ role: "user", content: currentTurn })
    history.push({ role: "assistant", content: `(ran ${calls.map((c) => c.name).join(", ")})` })
    currentTurn = `Tool results:\n${results.join("\n")}\n\nAnswer the owner now.`
  }

  // Out of rounds. Saying so is better than a silent empty reply, and better than looping on the
  // owner's money.
  return {
    kind: "reply",
    text: "I checked several things but could not finish that in one go. Ask me again, more narrowly.",
    ran,
  }
}
