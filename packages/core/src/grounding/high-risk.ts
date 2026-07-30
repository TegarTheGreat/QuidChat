function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Returns the high-risk topics that appear in `text` at the START of a word.
 *
 * The guard is only placed at the FRONT of the topic, not at the back. That's
 * deliberate:
 * - front guard -> "dilegalisir", "ilegal", "menghargai" are NOT detected, because
 *                   the topic is preceded by other letters;
 * - back guard (absent) -> "harganya", "stoknya", "garansinya" ARE STILL
 *                   detected, and in Indonesian these suffixed forms are the
 *                   ones customers use most often.
 *
 * The consequence is that a word like "hargai" also gets detected. That's a
 * conscious trade-off: for a guardrail, over-triggering only makes the bot ask
 * for a source on a sentence that didn't need one, while under-triggering lets
 * an unsourced business claim reach the customer. When in doubt, lean toward
 * detecting.
 */
export function detectHighRisk(text: string, topics: string[]): string[] {
  const found: string[] = []
  for (const topic of topics) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(topic)}`, "iu")
    if (re.test(text)) found.push(topic)
  }
  return found
}
