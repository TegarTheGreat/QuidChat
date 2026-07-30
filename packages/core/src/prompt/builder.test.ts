import { describe, expect, it } from "vitest"
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
    // Assertion pada kalimat hasil interpolasi, BUKAN pada kata "garansi" saja.
    // Kata itu juga muncul di teks aturan statis, jadi `toContain("garansi")`
    // tetap lolos walau `config.highRiskTopics` tidak pernah dirender sama
    // sekali — assertion yang tidak membuktikan apa pun.
    expect(p.system).toContain("Topik yang selalu dianggap pernyataan bisnis: harga, garansi.")
  })

  it("riwayat diteruskan apa adanya, tapi bukan array milik pemanggil", () => {
    const p = buildPrompt({ config, history, candidates: [], question: "q" })
    expect(p.history).toEqual(history)
    expect(p.history).not.toBe(history)
  })
})
