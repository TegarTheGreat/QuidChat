import { describe, expect, it } from "vitest"
import { chunkText } from "./chunk.js"

/**
 * A sentence of roughly `n` characters: capitalised first letter, full stop at the end.
 * The capital matters — the mid-sentence test asserts that chunks start the way a real
 * sentence starts, so a helper producing lowercase text would fail it for the wrong
 * reason and teach us nothing about the chunker.
 */
function sentence(n: number, word = "warranty"): string {
  const body = (`${word} `).repeat(Math.ceil(n / (word.length + 1))).slice(0, n - 1).trim()
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

const ENDS_A_SENTENCE = /[.!?]$/
const STARTS_A_SENTENCE = /^[A-Z0-9"'(]/

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    // An empty chunk would be embedded, retrieved, and then cited as evidence for
    // nothing at all — worse than having no chunk.
    expect(chunkText("")).toEqual([])
    expect(chunkText("   \n\n  \t ")).toEqual([])
  })

  it("keeps short text as a single chunk containing all of it", () => {
    const text = "Warranty covers twelve months. Shipping takes two days."
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe(text)
  })

  it("never begins or ends a chunk mid-sentence when the text allows it", () => {
    // This is the property the whole function exists for. A chunk beginning
    // mid-sentence hands the model a fragment whose subject is missing.
    //
    // The sizes here are chosen so the chunker MUST split inside a paragraph: each
    // paragraph is about 900 characters against a 400-character target. An earlier
    // version of this test used 400-character paragraphs against the 900 default, so
    // nothing was ever split and it passed even when the implementation was replaced
    // with a plain fixed-size cut. A test that cannot fail proves nothing.
    const paragraphs = Array.from({ length: 5 }, (_, i) =>
      [
        sentence(300, `topic${i}`),
        sentence(300, `detail${i}`),
        sentence(300, `extra${i}`),
      ].join(" "),
    ).join("\n\n")

    const chunks = chunkText(paragraphs, { target: 400, max: 700 })
    expect(chunks.length).toBeGreaterThan(5) // more chunks than paragraphs: it split inside them
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(ENDS_A_SENTENCE)
      expect(chunk.content).toMatch(STARTS_A_SENTENCE)
    }
  })

  it("splits a single sentence that exceeds the hard maximum on its own", () => {
    // Refusing to split would silently drop content, which is worse than an awkward cut.
    const monster = sentence(3000)
    const chunks = chunkText(monster, { target: 900, max: 1000 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1000)
  })

  it("loses no content when it hard-splits", () => {
    const monster = sentence(2500)
    const rejoined = chunkText(monster, { target: 800, max: 900 })
      .map((c) => c.content)
      .join(" ")
      .replace(/\s+/g, " ")
    const original = monster.replace(/\s+/g, " ")
    // Every word of the original must survive somewhere. Compared as word sets because
    // the overlap deliberately repeats text.
    for (const word of new Set(original.split(" "))) {
      expect(rejoined).toContain(word)
    }
  })

  it("repeats whole trailing sentences into the next chunk, never partial ones", () => {
    // Overlap is counted in sentences precisely so it cannot reintroduce the
    // mid-sentence starts this function exists to prevent.
    const text = Array.from({ length: 6 }, (_, i) => sentence(250, `part${i}`)).join(" ")
    const chunks = chunkText(text, { target: 600, max: 800, overlapSentences: 1 })
    expect(chunks.length).toBeGreaterThan(1)

    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]!.content
      const firstSentence = `${chunks[i]!.content.split(". ")[0]!}.`
      expect(previous).toContain(firstSentence)
    }
  })

  it("emits sequential ordinals from zero with no gaps", () => {
    // `chunks.ordinal` is NOT NULL and the admin panel lists documents in this order.
    const text = Array.from({ length: 10 }, (_, i) => sentence(300, `item${i}`)).join("\n\n")
    const chunks = chunkText(text, { target: 500, max: 700 })
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it("produces no empty chunk from Windows line endings or repeated blank lines", () => {
    const text = "First paragraph here.\r\n\r\n\r\n\r\nSecond paragraph here.\r\n\r\n\r\n"
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(chunk.content.trim().length).toBeGreaterThan(0)
    // The carriage returns must not survive into indexed text.
    for (const chunk of chunks) expect(chunk.content).not.toContain("\r")
  })

  it("joins a paragraph's own line wrapping into flowing text", () => {
    // Hard-wrapped source text would otherwise embed with newlines mid-sentence.
    const chunks = chunkText("Warranty covers\ntwelve months\nfrom purchase.")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe("Warranty covers twelve months from purchase.")
  })

  it("does not emit a final chunk that its predecessor already contains", () => {
    // The carried overlap can otherwise duplicate the previous chunk's tail, costing a
    // row and an embedding for text that is already indexed.
    const text = `${sentence(400, "alpha")} ${sentence(400, "beta")}`
    const chunks = chunkText(text, { target: 500, max: 900, overlapSentences: 1 })
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1]!.content).not.toBe(chunks[i]!.content)
      expect(chunks[i - 1]!.content.includes(chunks[i]!.content)).toBe(false)
    }
  })
})
