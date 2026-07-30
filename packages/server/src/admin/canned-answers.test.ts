import { describe, expect, it } from "vitest"
import { Readable } from "node:stream"
import { setCannedAnswerStatus } from "./canned-answers.js"
import type { AdminDeps } from "./shared.js"

function request(body: unknown): never {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>
  stream.headers = { "content-type": "application/json" }
  stream.method = "POST"
  return stream as never
}

class FakeResponse {
  status = 0
  body: unknown
  writeHead(status: number): this {
    this.status = status
    return this
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body = JSON.parse(String(chunk))
  }
}

/** No database: these requests must be rejected on shape, before any lookup. */
const deps = { db: null } as unknown as AdminDeps

describe("publishing and un-publishing an answer", () => {
  it("refuses a request that does not say which way", async () => {
    // `approved` used to default to false, so a caller that omitted it — or spelled it
    // differently — silently REVOKED a live answer and got a 200 saying it worked. An answer
    // disappearing from customers is not something to infer from a missing field.
    for (const body of [
      { tenantSlug: "shop", id: "a1" },
      { tenantSlug: "shop", id: "a1", status: "approved" },
      { tenantSlug: "shop", id: "a1", approved: "true" },
    ]) {
      const res = new FakeResponse()
      await setCannedAnswerStatus(request(body), res as never, deps)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((res.body as { error: string }).error).toMatch(/approved must be true or false/)
    }
  })

  it("still needs an id", async () => {
    const res = new FakeResponse()
    await setCannedAnswerStatus(request({ tenantSlug: "shop", approved: true }), res as never, deps)
    expect(res.status).toBe(400)
  })
})
