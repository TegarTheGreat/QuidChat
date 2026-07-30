// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import { clearToken, getToken, setToken } from "./token.js"

describe("token storage", () => {
  beforeEach(() => {
    clearToken()
    localStorage.clear()
    sessionStorage.clear()
  })

  it("never writes the admin token to localStorage", () => {
    setToken("super-secret-admin-token")

    expect(getToken()).toBe("super-secret-admin-token")
    expect(sessionStorage.getItem("quidchat-admin-token")).toBe("super-secret-admin-token")
    // The whole point: localStorage survives until explicitly cleared and is
    // readable by any script that ever lands on the origin. It must stay empty.
    expect(localStorage.getItem("quidchat-admin-token")).toBeNull()
    expect(localStorage.length).toBe(0)
  })
})
