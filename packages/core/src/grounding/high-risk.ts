function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Mengembalikan topik berisiko tinggi yang muncul di `text` sebagai AWAL kata.
 *
 * Penjaga hanya dipasang di DEPAN topik, bukan di belakang. Itu disengaja:
 * - di depan  -> "dilegalisir", "ilegal", "menghargai" TIDAK terdeteksi, karena
 *                topiknya didahului huruf lain;
 * - di belakang (tidak ada) -> "harganya", "stoknya", "garansinya" TETAP
 *                terdeteksi, dan dalam bahasa Indonesia bentuk bersufiks inilah
 *                yang paling sering dipakai pelanggan.
 *
 * Konsekuensinya kata seperti "hargai" ikut terdeteksi. Itu diterima secara
 * sadar: untuk guardrail, memicu berlebih hanya membuat bot meminta sumber untuk
 * kalimat yang tak memerlukannya, sedangkan kurang memicu meloloskan klaim bisnis
 * tanpa sumber ke pelanggan. Ketika ragu, condong ke arah mendeteksi.
 */
export function detectHighRisk(text: string, topics: string[]): string[] {
  const found: string[] = []
  for (const topic of topics) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(topic)}`, "iu")
    if (re.test(text)) found.push(topic)
  }
  return found
}
