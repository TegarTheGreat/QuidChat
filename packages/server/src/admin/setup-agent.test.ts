import { describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import { readFileSync } from "node:fs"
import { SETUP_TOOLS } from "@quidchat/core"
import {
  executorForTest,
  OFFERED_SETUP_TOOLS,
  postSetupChat,
  requiresConfirmation,
} from "./setup-agent.js"
import type { AdminDeps } from "./shared.js"

function request(body: unknown): never {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>
  stream.headers = { "content-type": "application/json" }
  stream.method = "POST"
  return stream as never
}

class FakeResponse {
  status = 0
  body: unknown = undefined
  writeHead(status: number): this {
    this.status = status
    return this
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body = JSON.parse(String(chunk))
  }
}

/** The route must not need a working model to refuse an unconfirmed action. */
const deps = {
  provider: { complete: vi.fn() },
  store: { getTenantConfig: async () => ({ chatModel: "m" }) },
  db: {},
} as unknown as AdminDeps

describe("the route's own confirmation gate", () => {
  it("refuses a destructive action that arrives without an explicit confirmation", async () => {
    // The gate is enforced twice on purpose. The agent hands a gated call back rather than
    // running it; this route refuses it again unless a person said yes. A gate enforced only
    // where the model runs is bypassed by anything that can reach this endpoint — and it is
    // reachable with an admin token, which is exactly the credential an owner pastes elsewhere.
    const res = new FakeResponse()
    await postSetupChat(
      request({
        tenantId: "t1",
        message: "clean up",
        confirm: { call: { id: "1", name: "delete_knowledge_source", input: { sourceId: "s1" } } },
      }),
      res as never,
      deps,
    )

    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/explicit confirmation/)
    // And the model was never asked to do anything either.
    expect(deps.provider.complete).not.toHaveBeenCalled()
  })

  it("agrees with the agent about which actions are gated", () => {
    // Two lists that can disagree is how a gate quietly stops covering something.
    expect(requiresConfirmation({ id: "1", name: "delete_knowledge_source", input: {} })).toBe(true)
    expect(requiresConfirmation({ id: "1", name: "set_provider_credential", input: {} })).toBe(true)
    expect(requiresConfirmation({ id: "1", name: "run_diagnostics", input: {} })).toBe(false)
  })

  it("needs a tenant and a message", async () => {
    const res = new FakeResponse()
    await postSetupChat(request({ message: "hi" }), res as never, deps)
    expect(res.status).toBe(400)
  })
})

describe("what the model is told it can do", () => {
  it("offers only tools the executor actually runs", () => {
    /*
     * Ten tool definitions used to go to the model while two were implemented, so it would offer
     * to create a skill, call the tool, and then explain to the owner why the thing it had just
     * offered had not happened. Every offered name has to have a case in the executor.
     *
     * Read from the source rather than from a second list here: a copy of the switch statement
     * would agree with itself forever.
     */
    const source = readFileSync(new URL("./setup-agent.ts", import.meta.url), "utf8")
    for (const tool of OFFERED_SETUP_TOOLS) {
      expect(source, tool.name).toContain(`case "${tool.name}":`)
    }
    expect(OFFERED_SETUP_TOOLS.length).toBeGreaterThan(0)
    // And it must be a real subset — offering everything again is the bug this guards.
    expect(OFFERED_SETUP_TOOLS.length).toBeLessThan(SETUP_TOOLS.length)
  })

  it("explains a setting from this build rather than from the model's memory", async () => {
    const executor = executorForTest()
    const good = await executor({ id: "1", name: "explain_setting", input: { name: "answer mode" } })
    // Spelled as an owner says it, matched to the column the panel writes.
    expect(good.ok).toBe(true)
    expect(good.ok && good.detail).toMatch(/answer_mode/)

    const bad = await executor({ id: "2", name: "explain_setting", input: { name: "turbo" } })
    // Naming the settings that do exist turns a dead end into the next question.
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.error).toMatch(/retention_days/)
  })
})

