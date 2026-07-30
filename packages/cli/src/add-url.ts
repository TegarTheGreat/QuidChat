import { applyMigrations, createDb } from "@quidchat/db"
import { fetchPage } from "@quidchat/ingest"
import { addText } from "./add-text.js"
import { readServeConfig } from "./config.js"

/**
 * Reads a page and indexes it as a knowledge source.
 *
 * Built on `addText` rather than beside it. Once the page has been fetched there is nothing
 * left that is specific to a URL — the same chunking, the same embeddings, the same source
 * row — and a second copy of that path is a second place for the two to drift.
 */
export async function runAddUrl(args: {
  env: Record<string, string | undefined>
  slug: string
  url: string
  title?: string
  log?: (line: string) => void
}): Promise<{ documentId: string; chunkCount: number }> {
  const log = args.log ?? ((line: string) => console.log(line))

  // Fetched before the database is even opened. A mistyped URL should cost nothing and leave
  // nothing behind — no migrations run, no source row to go and delete.
  const page = await fetchPage(args.url)
  log(`read ${page.finalUrl} (${page.text.length} characters)`)

  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)

  return addText({
    db,
    env: args.env,
    slug: args.slug,
    // The page's own title unless the operator named it. A page called "Home | Acme" is
    // harder to recognise in a citation than "Delivery terms".
    title: args.title?.trim() || page.title,
    text: page.text,
    kind: "url",
    url: page.finalUrl,
    log,
  })
}
