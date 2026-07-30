// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { readConfig } from "./config.js"

function makeScript(attrs: Record<string, string>, src = "https://cdn.example.test/widget.js"): HTMLScriptElement {
  const script = document.createElement("script")
  script.src = src
  for (const [key, value] of Object.entries(attrs)) {
    script.setAttribute(key, value)
  }
  return script
}

describe("readConfig", () => {
  it("throws, naming the missing attribute, when the tenant slug is absent", () => {
    const script = makeScript({})
    expect(() => readConfig(script)).toThrow(/data-quidchat-tenant/)
  })

  it("throws when the tenant attribute is present but empty", () => {
    const script = makeScript({ "data-quidchat-tenant": "" })
    expect(() => readConfig(script)).toThrow(/data-quidchat-tenant/)
  })

  it("reads the tenant slug and an explicit API base", () => {
    const script = makeScript({
      "data-quidchat-tenant": "acme",
      "data-quidchat-api": "https://api.example.test",
    })
    expect(readConfig(script)).toEqual({ tenantSlug: "acme", apiBase: "https://api.example.test" })
  })

  it("defaults the API base to the origin the script itself was served from", () => {
    const script = makeScript({ "data-quidchat-tenant": "acme" }, "https://cdn.example.test/widget.js")
    expect(readConfig(script).apiBase).toBe("https://cdn.example.test")
  })

  it("trims a trailing slash from an explicit API base", () => {
    const script = makeScript({
      "data-quidchat-tenant": "acme",
      "data-quidchat-api": "https://api.example.test/",
    })
    expect(readConfig(script).apiBase).toBe("https://api.example.test")
  })

  it("treats a trailing-slash API base the same as one without", () => {
    const withSlash = makeScript({
      "data-quidchat-tenant": "acme",
      "data-quidchat-api": "https://api.example.test/",
    })
    const withoutSlash = makeScript({
      "data-quidchat-tenant": "acme",
      "data-quidchat-api": "https://api.example.test",
    })
    expect(readConfig(withSlash)).toEqual(readConfig(withoutSlash))
  })
})
