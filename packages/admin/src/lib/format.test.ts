import { describe, expect, it } from "vitest"
import { formatDateTime, formatRelative } from "./format"

describe("formatDateTime", () => {
  it("parses the form Postgres actually sends, both of whose quirks break Date", () => {
    // A space instead of T, and a two-digit offset where ISO wants +00:00.
    const formatted = formatDateTime("2026-07-30 14:27:00.406+00")
    // Asserting on "2026" alone is what the first version of this test did, and it passed while
    // the helper was returning the input untouched — the raw string contains "2026" too. The
    // assertion has to be something only a parsed date can produce.
    expect(formatted).not.toBe("2026-07-30 14:27:00.406+00")
    expect(formatted).not.toMatch(/Invalid/)
    expect(formatted).toMatch(/Jul/)
    // The fractional seconds and the offset are noise to a reader and must be gone.
    expect(formatted).not.toMatch(/406|\+00/)
  })

  it("accepts the ISO forms too", () => {
    expect(formatDateTime("2026-07-30T14:27:00.406Z")).toMatch(/Jul/)
    expect(formatDateTime("2026-07-30 14:27:00+05:30")).toMatch(/Jul/)
  })

  it("shows the raw value rather than Invalid Date", () => {
    expect(formatDateTime("not a date")).toBe("not a date")
    expect(formatDateTime(null)).toBe("—")
    expect(formatDateTime(undefined)).toBe("—")
  })
})

/** A timestamp that many seconds in the past, in the ISO form the API also emits. */
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

describe("formatRelative", () => {
  it("counts in the unit a reader would use", () => {
    expect(formatRelative(ago(10))).toBe("just now")
    expect(formatRelative(ago(60))).toBe("1 minute ago")
    expect(formatRelative(ago(3 * 3600))).toBe("3 hours ago")
    expect(formatRelative(ago(2 * 86_400))).toBe("2 days ago")
  })

  it("falls back to a date once the exact day matters again", () => {
    expect(formatRelative(ago(30 * 86_400))).toMatch(/2026|2025/)
  })
})
