import { describe, expect, it, vi } from "vitest"
import { buildPrompt, prefixOf } from "./builder.js"
import type { Candidate, TenantConfig } from "../types.js"

const config: TenantConfig = {
  chatModel: "claude-opus-5",
  rewriteModel: "claude-opus-5",
  embeddingModel: "text-embedding-3-small",
  refusalText: "Maaf, saya belum punya info itu.",
  highRiskTopics: ["harga", "garansi"],
}

const history = [
  { role: "user" as const, content: "halo" },
  { role: "assistant" as const, content: "Halo! Ada yang bisa dibantu?" },
]

const c = (id: string, content: string): Candidate =>
  ({ id, content, documentTitle: "Katalog" })

describe("buildPrompt", () => {
  it("prefix byte-identik untuk pertanyaan berbeda", () => {
    const a = buildPrompt({ config, history, candidates: [c("k1", "Garansi 12 bulan")], question: "garansi?" })
    const b = buildPrompt({ config, history, candidates: [c("k2", "Harga 200rb")], question: "harga?" })
    expect(prefixOf(a)).toBe(prefixOf(b))
  })

  it("prefix berubah bila konfigurasi tenant berubah", () => {
    const a = buildPrompt({ config, history, candidates: [], question: "x" })
    const b = buildPrompt({
      config: { ...config, refusalText: "beda" },
      history, candidates: [], question: "x",
    })
    expect(prefixOf(a)).not.toBe(prefixOf(b))
  })

  it("konteks hasil retrieve masuk turn sekarang, bukan system", () => {
    const p = buildPrompt({
      config, history,
      candidates: [c("k1", "Garansi resmi 12 bulan")],
      question: "garansi berapa lama?",
    })
    expect(p.system).not.toContain("Garansi resmi 12 bulan")
    expect(p.currentTurn).toContain("Garansi resmi 12 bulan")
  })

  it("menyertakan id chunk agar model bisa menyitasinya", () => {
    const p = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q" })
    expect(p.currentTurn).toContain("k1")
  })

  it("system prompt memuat teks penolakan dan daftar topik berisiko tenant", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.system).toContain("Maaf, saya belum punya info itu.")
    // Assertion on the interpolated sentence, NOT just on the word "garansi".
    // That word also appears in the static rules text, so `toContain("garansi")`
    // would still pass even if `config.highRiskTopics` was never rendered at
    // all — an assertion that proves nothing.
    expect(p.system).toContain("Topik yang selalu dianggap pernyataan bisnis: harga, garansi.")
  })

  it("riwayat diteruskan apa adanya, tapi bukan array milik pemanggil", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.history).toEqual(history)
    expect(p.history).not.toBe(history)
  })

  it("prefix tetap identik walau waktu berjalan di antara dua pemanggilan", () => {
    // This is the regression spec §11.1 cites as the reason this test exists: a single
    // `new Date()` in the system prompt would invalidate the cache on every message,
    // with no error and no log. A test without a fake clock would NOT catch it — two
    // calls would land in the same millisecond, so the timestamps would coincidentally
    // match and the prefix would still compare equal.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const a = buildPrompt({ config, history, candidates: [c("k1", "isi")], question: "q1" })
      vi.advanceTimersByTime(60 * 60 * 1000) // one hour
      const b = buildPrompt({ config, history, candidates: [c("k2", "lain")], question: "q2" })
      expect(prefixOf(a)).toBe(prefixOf(b))
    } finally {
      vi.useRealTimers()
    }
  })
})
