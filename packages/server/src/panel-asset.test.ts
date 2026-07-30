import { describe, expect, it } from "vitest"
import { resolvePanelPath } from "./panel-asset.js"

describe("resolvePanelPath", () => {
  it("maps the panel root and a directory to index.html", () => {
    for (const path of ["/panel", "/panel/", "/panel/skills/"]) {
      expect(resolvePanelPath(path), path).toMatch(/admin\/dist\/(skills\/)?index\.html$/)
    }
  })

  it("maps an asset to its file", () => {
    expect(resolvePanelPath("/panel/assets/index-abc123.js")).toMatch(
      /admin\/dist\/assets\/index-abc123\.js$/,
    )
  })

  it("refuses to escape the build directory", () => {
    // The resolved path is what is checked, so an encoded traversal is caught as well as a
    // literal one — a check on the raw string would be walked past with %2e%2e%2f, and the
    // prize for walking past it is the server's own .env.
    for (const path of [
      "/panel/../../../etc/passwd",
      "/panel/%2e%2e%2f%2e%2e%2f.env",
      "/panel/assets/../../../../root/.ssh/id_rsa",
    ]) {
      expect(resolvePanelPath(path), path).toBeNull()
    }
  })

  it("refuses a malformed escape sequence", () => {
    expect(resolvePanelPath("/panel/%zz")).toBeNull()
  })
})
