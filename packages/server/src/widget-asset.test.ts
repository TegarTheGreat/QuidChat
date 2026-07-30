import { describe, expect, it } from "vitest"
import { handleWidgetAsset } from "./widget-asset.js"

/** Just enough of `ServerResponse` to record what the handler wrote. */
class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  body = ""

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.status = status
    this.headers = { ...this.headers, ...headers }
    return this
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body = String(chunk)
  }
}

describe("cache headers on a fixed URL", () => {
  it("lets a rebuilt bundle reach a browser that already has one", async () => {
    // The embed snippet is a fixed `<script src=".../quidchat.js">`, so the URL does not change
    // when the bundle does. This was served `immutable, max-age=31536000` on the reasoning that
    // a deploy replaces the file rather than mutating it — but a browser caches by URL. Every
    // site that had ever loaded the widget kept a year-old copy and would never receive a fix,
    // security or otherwise. Found in a browser: a rebuilt bundle simply did not appear.
    const res = new FakeResponse()
    await handleWidgetAsset(res as never)

    expect(res.status).toBe(200)
    const cacheControl = String(res.headers["cache-control"])
    expect(cacheControl).not.toContain("immutable")
    expect(cacheControl).toMatch(/must-revalidate/)
    expect(String(res.headers.etag)).toMatch(/^"[a-f0-9]{32}"$/)
  })

  it("answers an unchanged bundle with 304 and no body", async () => {
    // The cost of revalidating on a stable URL: a round trip with no payload, rather than
    // re-sending the whole bundle to every visitor.
    const first = new FakeResponse()
    await handleWidgetAsset(first as never)
    const etag = String(first.headers.etag)

    const second = new FakeResponse()
    await handleWidgetAsset(second as never, { headers: { "if-none-match": etag } } as never)

    expect(second.status).toBe(304)
    expect(second.body).toBe("")
    expect(second.headers.etag).toBe(etag)
  })

  it("sends the bundle to a browser holding a stale tag", async () => {
    const res = new FakeResponse()
    await handleWidgetAsset(res as never, { headers: { "if-none-match": '"stale"' } } as never)

    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
  })
})
