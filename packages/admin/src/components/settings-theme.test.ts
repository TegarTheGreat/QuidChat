import { describe, expect, it } from "vitest"
import { mergeWidgetTheme } from "./settings-theme.js"

/**
 * The theme is a jsonb blob and the settings form knows only part of it.
 *
 * `handleSave` used to rebuild it from the fields on screen, so a shop that opened Settings to
 * change its accent colour silently lost its language, greeting and opening questions — its
 * customers reverted to English chrome with nothing to tap, and nothing said so.
 */
describe("saving the widget theme", () => {
  it("keeps settings this form does not show", () => {
    const merged = mergeWidgetTheme(
      { primaryColor: "#000", position: "left", title: "Old", somethingNewer: "keep me" },
      { primaryColor: "#0b5cd5", position: "right", title: "New", locale: "id", greeting: "Halo", starters: [] },
    )
    expect(merged.somethingNewer).toBe("keep me")
    expect(merged.primaryColor).toBe("#0b5cd5")
    expect(merged.title).toBe("New")
  })

  it("writes the fields it does show", () => {
    const merged = mergeWidgetTheme(
      {},
      { primaryColor: "#fff", position: "right", title: "T", locale: "id", greeting: "Halo", starters: ["Berapa lama garansinya?"] },
    )
    expect(merged.locale).toBe("id")
    expect(merged.greeting).toBe("Halo")
    expect(merged.starters).toEqual(["Berapa lama garansinya?"])
  })

  it("removes the question list rather than storing an empty one", () => {
    // Absent is not the same as empty: absent is what makes the widget fall back to the
    // business's own approved answers. An empty array would mean "offer nothing".
    const merged = mergeWidgetTheme(
      { starters: ["old question"] },
      { primaryColor: "#fff", position: "right", title: "T", locale: "en", greeting: "", starters: [] },
    )
    expect("starters" in merged).toBe(false)
  })
})
