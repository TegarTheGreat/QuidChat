/**
 * Reads a PDF into the text worth indexing.
 *
 * Price lists, warranty terms, delivery policies and product catalogues are PDFs in most
 * businesses, and until now the answer was to open one and paste it in by hand. That is the step
 * where an owner gives up, and the assistant then refuses questions the business has answered in
 * writing for years.
 *
 * `unpdf` is Mozilla's pdf.js packaged to run in Node without native dependencies, so this adds a
 * dependency to the ingest package and nothing to what a customer downloads — the widget never
 * sees it.
 */

export class PdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdfError"
  }
}

export type ExtractedPdf = {
  text: string
  pageCount: number
}

/** Guarded like every other ingest path: a hostile or simply enormous file must not exhaust the
 *  server's memory on its way to being refused. */
const MAX_BYTES = 20 * 1024 * 1024

/**
 * Pulls the text out of a PDF's pages.
 *
 * Page text is joined with blank lines rather than run together, because the chunker splits on
 * paragraphs: without the break, a whole document collapses into one chunk and retrieval returns
 * everything or nothing.
 *
 * A PDF with no extractable text is refused with a message that says why. Scans and exports that
 * draw their letters as images are common, and "0 chunks indexed" would leave an owner believing
 * the file was read.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdf> {
  if (bytes.byteLength === 0) throw new PdfError("that file is empty")
  if (bytes.byteLength > MAX_BYTES) {
    throw new PdfError(`that PDF is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  }
  // `%PDF` — checked before handing it to a parser, so a mis-named file fails with a sentence
  // rather than with a stack trace from somewhere inside pdf.js.
  const header = new TextDecoder().decode(bytes.subarray(0, 5))
  if (!header.startsWith("%PDF")) throw new PdfError("that file is not a PDF")

  const { extractText } = await import("unpdf")
  // pdf.js takes ownership of the buffer and detaches it, so the caller's array is left empty
  // afterwards. Copying costs one allocation and means reading a file twice — to retry it, to
  // hash it, to keep it — does not silently see nothing the second time.
  const owned = bytes.slice()
  let pages: string[]
  let pageCount: number
  try {
    const result = await extractText(owned, { mergePages: false })
    pages = (Array.isArray(result.text) ? result.text : [result.text]) as string[]
    pageCount = result.totalPages
  } catch (cause) {
    throw new PdfError(
      `that PDF could not be read — it may be encrypted or damaged (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    )
  }

  const text = pages
    .map((page) => page.replace(/[ \t]+\n/g, "\n").trim())
    .filter((page) => page !== "")
    .join("\n\n")

  if (text.trim() === "") {
    throw new PdfError(
      "that PDF has no text in it — a scan draws its letters as pictures, so it needs to be run " +
        "through OCR first, or the text pasted in",
    )
  }
  return { text, pageCount }
}
