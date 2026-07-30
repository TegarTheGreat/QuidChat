import { describe, expect, it } from "vitest"
import { detectHighRisk } from "./high-risk.js"

const TOPICS = ["harga", "diskon", "garansi", "refund", "stok", "legal"]

describe("detectHighRisk", () => {
  it("mendeteksi topik yang muncul apa adanya", () => {
    expect(detectHighRisk("Harga produk ini 200 ribu", TOPICS)).toEqual(["harga"])
  })

  it("tidak peduli huruf besar-kecil", () => {
    expect(detectHighRisk("GARANSI resmi 1 tahun", TOPICS)).toEqual(["garansi"])
  })

  it("mengembalikan beberapa topik sekaligus", () => {
    expect(detectHighRisk("ada diskon dan stok masih banyak", TOPICS).sort())
      .toEqual(["diskon", "stok"])
  })

  it("kosong untuk sapaan biasa", () => {
    expect(detectHighRisk("Halo, terima kasih banyak", TOPICS)).toEqual([])
  })

  it("tidak cocok bila topik didahului huruf lain", () => {
    // "legal" tidak boleh terpicu oleh "dilegalisir" atau "ilegal"
    expect(detectHighRisk("dokumen sudah dilegalisir", TOPICS)).toEqual([])
    expect(detectHighRisk("proses ilegal itu", TOPICS)).toEqual([])
    expect(detectHighRisk("saya menghargai bantuannya", TOPICS)).toEqual([])
  })

  it("TETAP cocok bila topik diberi sufiks — kritis untuk bahasa Indonesia", () => {
    expect(detectHighRisk("harganya berapa?", TOPICS)).toEqual(["harga"])
    expect(detectHighRisk("stoknya habis", TOPICS)).toEqual(["stok"])
    expect(detectHighRisk("garansinya berapa lama", TOPICS)).toEqual(["garansi"])
    expect(detectHighRisk("refundnya bisa?", TOPICS)).toEqual(["refund"])
    expect(detectHighRisk("diskonnya ada?", TOPICS)).toEqual(["diskon"])
  })

  it("menghormati daftar topik kustom per tenant", () => {
    expect(detectHighRisk("dosis yang dianjurkan", ["dosis"])).toEqual(["dosis"])
  })
})
