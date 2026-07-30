// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { readConversationId, rememberConversationId } from "./session.js"
import type { WidgetConfig } from "./config.js"

const shop: WidgetConfig = { tenantSlug: "shop", apiBase: "https://api.example" }
const other: WidgetConfig = { tenantSlug: "other-shop", apiBase: "https://api.example" }

afterEach(() => {
  // Unstub first: the throwing stub from the last test has no `clear`, and tearing down in the
  // other order fails the test that just proved the guard works.
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe("remembering a conversation", () => {
  it("carries the id across a page load", () => {
    expect(readConversationId(shop)).toBeUndefined()
    rememberConversationId(shop, "conv-1")
    // A customer moving from a product page to checkout continues the same conversation, so the
    // assistant still has the history a follow-up question depends on.
    expect(readConversationId(shop)).toBe("conv-1")
  })

  it("keeps two assistants on one page apart", () => {
    rememberConversationId(shop, "conv-1")
    rememberConversationId(other, "conv-2")
    expect(readConversationId(shop)).toBe("conv-1")
    expect(readConversationId(other)).toBe("conv-2")
  })

  it("carries on when the browser refuses to store anything", () => {
    // sessionStorage throws rather than returning null in a sandboxed iframe and wherever site
    // data is blocked. A widget that failed to mount over something optional would be trading an
    // answer for a convenience.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    })

    expect(() => rememberConversationId(shop, "conv-1")).not.toThrow()
    expect(readConversationId(shop)).toBeUndefined()
  })
})
