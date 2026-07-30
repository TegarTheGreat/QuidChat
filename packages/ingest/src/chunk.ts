export type Chunk = { ordinal: number; content: string }

export type ChunkOptions = {
  /** Preferred chunk size in characters. Chunks land near this, not exactly on it. */
  target?: number
  /** Hard ceiling. Only a single sentence longer than this is cut mid-sentence. */
  max?: number
  /** How many trailing sentences of a chunk are repeated at the start of the next. */
  overlapSentences?: number
}

/**
 * Defaults tuned for prose. These numbers are a starting point, not a law, and the
 * admin panel will expose them — but they matter more than they look.
 *
 * Too small and a chunk loses its subject: "It covers accidental damage" is useless
 * without the sentence naming what "it" is. Too large and retrieval returns mostly
 * irrelevant text, which dilutes the prompt, costs tokens on every message, and makes
 * the model more likely to cite a chunk that only tangentially supports the claim.
 */
const DEFAULT_TARGET = 900
const DEFAULT_MAX = 1200
const DEFAULT_OVERLAP_SENTENCES = 1

/**
 * Splits text into sentences.
 *
 * Deliberately simple: a terminator followed by whitespace. This mis-splits after
 * abbreviations like "No." or "Rp.", and that is an accepted trade for having no
 * dependency. The consequence of a wrong split here is a slightly awkward chunk
 * boundary, not lost content — every character still lands in exactly one chunk.
 */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Cuts an oversized single sentence into `max`-sized slices, preferring word breaks. */
function hardSplit(sentence: string, max: number): string[] {
  const slices: string[] = []
  let rest = sentence
  while (rest.length > max) {
    // Look for a space in the last fifth of the window so a word is not sliced in half
    // unless the text genuinely has no break there.
    const window = rest.slice(0, max)
    const breakAt = window.lastIndexOf(" ", max)
    const cut = breakAt > max * 0.8 ? breakAt : max
    slices.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) slices.push(rest)
  return slices
}

/**
 * Splits text into chunks that respect sentence boundaries.
 *
 * WHY NOT A FIXED-SIZE CUT, which is the usual first implementation: a chunk that
 * begins mid-sentence hands the model a fragment whose subject is missing, and the
 * model attaches that fragment to whatever context it does have. The result is a
 * cited claim the source does not actually support — and the grounding validator
 * cannot catch it, because the citation genuinely is in the candidate set. Retrieval
 * quality is decided here, not in the search query.
 *
 * So: paragraphs first, then sentences, and a hard cut only when one sentence exceeds
 * `max` on its own. Refusing to cut it would silently drop content, which is worse
 * than an awkward boundary.
 *
 * OVERLAP IS COUNTED IN SENTENCES, NOT CHARACTERS. A character-based overlap would
 * reintroduce exactly the problem this function exists to avoid — every chunk after
 * the first would begin mid-sentence. Repeating whole trailing sentences gives the
 * same benefit, that a fact stated across a boundary appears complete in at least one
 * chunk, without breaking the invariant.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.target ?? DEFAULT_TARGET
  const max = opts.max ?? DEFAULT_MAX
  const overlapSentences = opts.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES

  // Normalise line endings before anything else. Windows input would otherwise leave
  // a stray carriage return at the end of every sentence, which changes the text that
  // gets embedded and indexed for no reason a user could ever see.
  const normalised = text.replace(/\r\n?/g, "\n").trim()
  if (normalised.length === 0) return []

  const paragraphs = normalised
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0)

  // Every piece is a whole sentence, except pieces produced by `hardSplit`.
  const pieces: string[] = []
  for (const paragraph of paragraphs) {
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length > max) pieces.push(...hardSplit(sentence, max))
      else pieces.push(sentence)
    }
  }

  const chunks: Chunk[] = []
  let current: string[] = []
  let currentLength = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({ ordinal: chunks.length, content: current.join(" ") })
    // Carry the trailing sentences forward so a fact spanning the boundary is whole
    // somewhere. Slicing from the end keeps whole sentences.
    const carried = overlapSentences > 0 ? current.slice(-overlapSentences) : []
    current = [...carried]
    currentLength = current.reduce((n, s) => n + s.length + 1, 0)
  }

  for (const piece of pieces) {
    // `currentLength > 0` guards the case where a single piece already exceeds target:
    // without it, flush() would emit an empty chunk before the oversized piece.
    if (currentLength > 0 && currentLength + piece.length + 1 > target) flush()

    // The overlap carried by flush() can itself push the chunk past `max` — a piece
    // sized at exactly `max` plus a carried sentence exceeds it. `max` is a hard
    // ceiling, so the overlap yields: better to lose the repeated sentence than to
    // emit a chunk larger than the limit, which would blow past the embedding model's
    // input window and fail at index time rather than here.
    if (currentLength > 0 && currentLength + piece.length + 1 > max) {
      current = []
      currentLength = 0
    }

    current.push(piece)
    currentLength += piece.length + 1
  }

  if (current.length > 0) {
    // The final flush must not carry overlap forward — there is nothing after it, and
    // doing so would emit a chunk containing only repeated text.
    chunks.push({ ordinal: chunks.length, content: current.join(" ") })
  }

  // The carried overlap can make the last chunk a duplicate of the previous one's tail
  // when the input ends exactly on a boundary. A chunk that is wholly contained in its
  // predecessor adds nothing to retrieval and costs a row and an embedding.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!
    const previous = chunks[chunks.length - 2]!
    if (previous.content.includes(last.content)) chunks.pop()
  }

  return chunks
}
