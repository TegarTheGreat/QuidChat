import { describe, expect, it } from "vitest"
import { Readable } from "node:stream"
import { putProviders } from "./providers.js"
import type { AdminDeps } from "./shared.js"

function request(body: unknown): never {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>
  stream.headers = { "content-type": "application/json" }
  stream.method = "PUT"
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

/** Rejected on shape, before any tenant lookup, so no database is needed. */
const deps = { db: null, env: {} } as unknown as AdminDeps

describe("what a provider credential is allowed to be", () => {
  it("refuses a name that is not an environment variable", async () => {
    // These names are read back into an env map. Anything else could only ever fail to match a
    // preset, silently, long after it was typed.
    for (const name of ["openai key", "OPENAI-KEY", "__proto__", "Öpenai"]) {
      const res = new FakeResponse()
      await putProviders(request({ tenantSlug: "shop", secrets: { [name]: "x" } }), res as never, deps)
      expect(res.status, name).toBe(400)
    }
  })

  it("refuses a base URL that is not http or https", async () => {
    // This server fetches that address when listing models, so the value decides where the
    // process makes a request.
    for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://host/"]) {
      const res = new FakeResponse()
      await putProviders(
        request({ tenantSlug: "shop", secrets: { OLLAMA_BASE_URL: url } }),
        res as never,
        deps,
      )
      expect(res.status, url).toBe(400)
    }
  })

  it("refuses an address carrying credentials", async () => {
    const res = new FakeResponse()
    await putProviders(
      request({ tenantSlug: "shop", secrets: { OLLAMA_BASE_URL: "http://user:pw@host/v1" } }),
      res as never,
      deps,
    )
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/username or password/)
  })

  it("still allows a local runner, which is a loopback address by definition", async () => {
    // Refusing private addresses the way page ingestion does would break pointing at Ollama on
    // the same machine, which is a reason to use this product rather than a threat to it.
    //
    // Reaching the database is the proof: validation runs first, so getting as far as a lookup
    // this fake cannot answer means the address was accepted.
    const res = new FakeResponse()
    await expect(
      putProviders(
        request({ tenantSlug: "shop", secrets: { OLLAMA_BASE_URL: "http://localhost:11434/v1" } }),
        res as never,
        deps,
      ),
    ).rejects.toThrow()
    expect(res.status).not.toBe(400)
  })
})
