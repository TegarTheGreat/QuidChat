import { describe, expect, it } from "vitest"
import { detectHighRisk } from "./high-risk.js"

const TOPICS = ["price", "discount", "warranty", "refund", "stock", "legal"]

describe("detectHighRisk", () => {
  it("detects a topic that appears as-is", () => {
    expect(detectHighRisk("The price of this product is 200 thousand", TOPICS)).toEqual(["price"])
  })

  it("is case-insensitive", () => {
    expect(detectHighRisk("WARRANTY official for 1 year", TOPICS)).toEqual(["warranty"])
  })

  it("returns several topics at once", () => {
    expect(detectHighRisk("there is a discount and stock is still plenty", TOPICS).toSorted())
      .toEqual(["discount", "stock"])
  })

  it("is empty for an ordinary greeting", () => {
    expect(detectHighRisk("Hello, thanks a lot", TOPICS)).toEqual([])
  })

  it("does not match when the topic is preceded by other letters", () => {
    // "legal" must not be triggered by "illegally" or "legalese"
    expect(detectHighRisk("the document was notarized", TOPICS)).toEqual([])
    expect(detectHighRisk("done illegally", TOPICS)).toEqual([])
    expect(detectHighRisk("I appreciate your help", TOPICS)).toEqual([])
  })

  it("STILL matches when the topic carries a suffix — critical for languages like Indonesian", () => {
    // Kept in Indonesian on purpose: these two cases exercise the suffix-handling
    // capability (the guard sits only at the front of the word), which matters for
    // languages, like Indonesian, where suffixes attach directly to the root with
    // no separating space (e.g. "harga" + "-nya" -> "harganya").
    const idTopics = ["harga", "garansi"]
    expect(detectHighRisk("harganya berapa?", idTopics)).toEqual(["harga"])
    expect(detectHighRisk("garansinya berapa lama", idTopics)).toEqual(["garansi"])
  })

  it("honours a custom per-tenant topic list", () => {
    expect(detectHighRisk("the recommended dosage", ["dosage"])).toEqual(["dosage"])
  })
})
