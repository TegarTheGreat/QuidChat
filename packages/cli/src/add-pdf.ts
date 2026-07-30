import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { applyMigrations, createDb } from "@quidchat/db"
import { extractPdfText } from "@quidchat/ingest"
import { addText } from "./add-text.js"
import { readServeConfig } from "./config.js"

/**
 * Indexes a PDF.
 *
 * Price lists, warranty terms and delivery policies live in PDFs at most businesses, and the
 * alternative was opening one and pasting it in by hand — the step where an owner gives up, after
 * which the assistant refuses questions the business has answered in writing for years.
 */
export async function runAddPdf(args: {
  env: Record<string, string | undefined>
  slug: string
  path: string
  title?: string
  log?: (line: string) => void
}): Promise<{ documentId: string; chunkCount: number }> {
  const log = args.log ?? ((line: string) => console.log(line))

  // Read and parsed before the database is opened, so an unreadable file costs nothing and leaves
  // nothing behind — the same order add-url and add-site use.
  const bytes = new Uint8Array(await readFile(args.path))
  const { text, pageCount } = await extractPdfText(bytes)
  log(`read ${args.path} (${pageCount} page(s), ${text.length} characters)`)

  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)

  return addText({
    db,
    env: args.env,
    slug: args.slug,
    // The file's name unless the operator named it: "price-list-2026.pdf" is something a customer
    // can recognise in a citation, and so is "Price list".
    title: args.title?.trim() || basename(args.path),
    text,
    log,
  })
}
