import { describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import { postSetupChat, requiresConfirmation } from "./setup-agent.js"
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
