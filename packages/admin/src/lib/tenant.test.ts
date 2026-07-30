// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("tenant storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("survives a remount: a fresh module load still sees the selected tenant", async () => {
    const first = await import("./tenant.js")
    first.setTenant("acme")

    // `vi.resetModules` plus a fresh dynamic import mimics what happens on a
    // real page reload (a brand new module instance, no in-memory state left
    // over) — the scenario this behavior exists for in the first place.
    vi.resetModules()
    const second = await import("./tenant.js")

    expect(second.getTenant()).toBe("acme")
    expect(localStorage.getItem("quidchat-admin-tenant")).toBe("acme")
  })
})
