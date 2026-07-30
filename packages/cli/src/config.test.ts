import { describe, expect, it } from "vitest"
import { readServeConfig } from "./config.js"

describe("readServeConfig", () => {
  it("defaults to an on-disk PGlite directory, not memory", () => {
    // An in-memory default would appear to work and then lose every document and
    // conversation on restart — data loss a user discovers days later.
    const config = readServeConfig({})
    expect(config.db).toEqual({ kind: "pglite", dataDir: "./.quidchat/data" })
    expect(config.dbOrigin).toContain("./.quidchat/data")
  })

  it("uses DATABASE_URL for the managed Postgres tier", () => {
    const config = readServeConfig({ DATABASE_URL: "postgres://localhost/quidchat" })
    expect(config.db).toEqual({ kind: "postgres", url: "postgres://localhost/quidchat" })
    expect(config.dbOrigin).toBe("DATABASE_URL")
  })

  it("honours QUIDCHAT_DATA_DIR", () => {
    const config = readServeConfig({ QUIDCHAT_DATA_DIR: "/var/lib/quidchat" })
    expect(config.db).toEqual({ kind: "pglite", dataDir: "/var/lib/quidchat" })
  })

  it("defaults the port when PORT is absent or empty", () => {
    expect(readServeConfig({}).port).toBe(3210)
    expect(readServeConfig({ PORT: "" }).port).toBe(3210)
  })

  it("reads a valid PORT", () => {
    expect(readServeConfig({ PORT: "8080" }).port).toBe(8080)
  })

  it("accepts PORT=0, which asks the OS for any free port", () => {
    // Rejecting zero would break both tests and any deployment that maps ports
    // externally, which is a large share of container setups.
    expect(readServeConfig({ PORT: "0" }).port).toBe(0)
  })

  it("treats an empty QUIDCHAT_DATA_DIR as unset, not as a directory named \"\"", () => {
    expect(readServeConfig({ QUIDCHAT_DATA_DIR: "  " }).db).toEqual({
      kind: "pglite", dataDir: "./.quidchat/data",
    })
  })

  it("accepts an explicit opt-in to in-memory storage", () => {
    const config = readServeConfig({ QUIDCHAT_DATA_DIR: "memory" })
    expect(config.db).toEqual({ kind: "pglite" })
    expect(config.dbOrigin).toContain("not persisted")
  })

  it("rejects a malformed PORT rather than falling back to the default", () => {
    // Falling back would start the server on a port the operator never asked for, and
    // they would learn about it from a failing health check somewhere else entirely.
    for (const bad of ["abc", "-1", "70000", "8080.5"]) {
      expect(() => readServeConfig({ PORT: bad })).toThrow(/PORT must be an integer/)
    }
  })
})
