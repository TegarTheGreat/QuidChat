import { describe, expect, it } from "vitest"
import { validateGrounding } from "./validator.js"
import type { Candidate } from "../types.js"

const TOPICS = ["harga", "diskon", "garansi", "refund", "stok", "legal"]
const candidates: Candidate[] = [
  { id: "chunk-1", content: "Garansi resmi 12 bulan.", documentTitle: "Kebijakan" },
  { id: "chunk-2", content: "Harga Rp200.000.", documentTitle: "Katalog" },
]

const run = (segments: Parameters<typeof validateGrounding>[0]["answer"]["segments"]) =>
  validateGrounding({ answer: { segments }, candidates, highRiskTopics: TOPICS })

describe("validateGrounding", () => {
  it("menolak klaim bisnis tanpa sitasi", () => {
    const v = run([{ kind: "business_claim", text: "Garansi 12 bulan.", citations: [] }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("missing_citation")
  })

  it("menolak sitasi di luar candidateSet", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-99"] },
    ])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unknown_citation")
  })

  it("menolak segmen general yang menyebut topik berisiko tinggi", () => {
    const v = run([{ kind: "general", text: "Harga kami paling murah kok." }])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toBe("unlabelled_high_risk")
  })

  it("meloloskan klaim bisnis dengan sitasi valid", () => {
    const v = run([
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual(["chunk-1"])
  })

  it("meloloskan sapaan berlabel general", () => {
    const v = run([{ kind: "general", text: "Halo! Tentu saya bantu." }])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.citedChunkIds).toEqual([])
  })

  it("mengumpulkan sitasi unik dari beberapa segmen", () => {
    const v = run([
      { kind: "general", text: "Halo!" },
      { kind: "business_claim", text: "Garansi 12 bulan.", citations: ["chunk-1"] },
      { kind: "business_claim", text: "Harganya Rp200.000.", citations: ["chunk-2", "chunk-1"] },
    ])
    expect(v.ok).toBe(true)
    // `toSorted()` bukan `sort()`: yang kedua mengubah array di dalam verdict,
    // jadi assertion berikutnya di test yang sama akan memeriksa data yang sudah
    // teracak urutannya oleh assertion sebelumnya.
    if (v.ok) expect(v.citedChunkIds.toSorted()).toEqual(["chunk-1", "chunk-2"])
  })

  it("menolak jawaban kosong", () => {
    const v = run([])
    expect(v.ok).toBe(false)
    // Violation-nya ikut diperiksa. Tanpa ini, implementasi yang menolak jawaban
    // kosong dengan label yang salah — misalnya `missing_citation` — tetap lolos,
    // dan pemanggil yang membedakan penyebab penolakan jadi salah bercabang.
    if (!v.ok) expect(v.violation).toBe("empty_answer")
  })
})
