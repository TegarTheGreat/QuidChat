import { describe, expect, it } from "vitest"
import { extractPdfText, PdfError } from "./pdf.js"

/**
 * A real PDF, built here rather than fixtured, so the parser is exercised against a document with
 * actual content streams instead of a mock that agrees with whatever we expect.
 */
function buildPdf(lines: string[]): Uint8Array {
  const drawn = lines
    .map((line, i) => `${i > 0 ? "0 -20 Td " : ""}(${line}) Tj`)
    .join(" ")
  const content = `BT /F1 12 Tf 72 720 Td ${drawn} ET`
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj",
    `4 0 obj<</Length ${content.length}>>stream${"\n"}${content}${"\n"}endstream endobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  ]

  let out = `%PDF-1.4${"\n"}`
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(out.length)
    out += `${object}${"\n"}`
  }
  const xref = out.length
  out += `xref${"\n"}0 ${objects.length + 1}${"\n"}0000000000 65535 f ${"\n"}`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n ${"\n"}`
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>${"\n"}startxref${"\n"}${xref}${"\n"}%%EOF`
  return new TextEncoder().encode(out)
}

describe("extractPdfText", () => {
  it("reads the words out of a real document", async () => {
    const pdf = buildPdf([
      "Returns are accepted within seven days.",
      "The warranty covers twelve months.",
    ])
    const result = await extractPdfText(pdf)

    expect(result.pageCount).toBe(1)
    expect(result.text).toContain("Returns are accepted within seven days.")
    expect(result.text).toContain("The warranty covers twelve months.")
  })

  it("refuses a file that is not a PDF, with a sentence rather than a stack trace", async () => {
    // Checked before the parser sees it, so a mis-named file does not fail somewhere inside
    // pdf.js where the message means nothing to whoever uploaded it.
    await expect(extractPdfText(new TextEncoder().encode("PK zip"))).rejects.toThrow(/not a PDF/)
    await expect(extractPdfText(new Uint8Array())).rejects.toThrow(/empty/)
  })

  it("says why a scan produced nothing rather than indexing nothing", async () => {
    // A scan draws its letters as pictures. "0 chunks indexed" would leave an owner believing the
    // file was read and their assistant simply unhelpful.
    const empty = buildPdf([])
    await expect(extractPdfText(empty)).rejects.toThrow(PdfError)
    await expect(extractPdfText(empty)).rejects.toThrow(/OCR|no text/)
  })

  it("refuses a file too large to hold in memory on the way to refusing it", async () => {
    const huge = new Uint8Array(21 * 1024 * 1024)
    huge.set(new TextEncoder().encode("%PDF-"), 0)
    await expect(extractPdfText(huge)).rejects.toThrow(/larger than/)
  })
})

describe("reading the same file twice", () => {
  it("leaves the caller's bytes intact", async () => {
    // pdf.js takes ownership of the buffer and detaches it. Without a copy the second read sees
    // an empty array and reports the file as empty — which is how this was found.
    const pdf = buildPdf(["Open daily."])
    const before = pdf.byteLength

    await extractPdfText(pdf)
    expect(pdf.byteLength).toBe(before)
    expect((await extractPdfText(pdf)).text).toContain("Open daily.")
  })
})
