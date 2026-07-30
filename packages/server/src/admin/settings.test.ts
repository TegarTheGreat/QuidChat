import { describe, expect, it } from "vitest"
import { onlySettingsRow } from "./settings.js"

/**
 * A tenant has exactly one settings row; its primary key says so.
 *
 * A database left inconsistent by an unclean shutdown can hold two live versions of that row
 * anyway — this session found exactly that state, on a directory whose server had been killed
 * rather than stopped. Reads then return one version and writes land on the other, so a business
 * changes a setting in the panel, sees success, and nothing happens. That is the failure worth
 * refusing to be quiet about.
 */
describe("onlySettingsRow", () => {
  it("returns the row when there is one", () => {
    const row = { tenant_id: "t1", refusal_text: "Sorry." }
    expect(onlySettingsRow([row], "t1")).toBe(row)
  })

  it("reports absence as absence, which the caller answers as a 404", () => {
    expect(onlySettingsRow([], "t1")).toBeNull()
  })

  it("refuses to guess when the invariant is broken", () => {
    const rows = [{ tenant_id: "t1" }, { tenant_id: "t1" }]
    // Taking the first row is what made this invisible: the panel would show one version and the
    // update would write the other, indefinitely.
    expect(() => onlySettingsRow(rows, "t1")).toThrow(/2 rows for t1/)
    expect(() => onlySettingsRow(rows, "t1")).toThrow(/unclean shutdown/)
  })
})
