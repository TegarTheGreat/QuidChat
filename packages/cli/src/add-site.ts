import { applyMigrations, createDb } from "@quidchat/db"
import { crawlSite } from "@quidchat/ingest"
import { addText } from "./add-text.js"
import { readServeConfig } from "./config.js"

/**
 * Reads a whole site and indexes every page it found.
 *
 * "Point it at my website" is what a business asks for; adding pages one URL at a time is what
 * they had to do instead, and they would never notice when a fifth page appeared.
 *
 * Each page becomes its own source, named by its own title, because a citation saying "Delivery
 * terms" is worth something to a customer and one saying "My Shop" is not.
 */
export async function runAddSite(args: {
  env: Record<string, string | undefined>
  slug: string
  url: string
  maxPages?: number
  log?: (line: string) => void
}): Promise<{ indexed: number; skipped: number }> {
  const log = args.log ?? ((line: string) => console.log(line))

  // Crawled before the database is opened, so a mistyped address costs nothing and leaves
  // nothing behind — the same order `add-url` uses.
  log(`reading ${args.url}…`)
  const result = await crawlSite({
    startUrl: args.url,
    ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
  })
  log(`found ${result.pages.length} page(s)`)

  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)

  let indexed = 0
  for (const page of result.pages) {
    try {
      const { chunkCount } = await addText({
        db,
        env: args.env,
        slug: args.slug,
        title: page.title,
        text: page.text,
        kind: "url",
        url: page.url,
        log: () => {},
      })
      indexed++
      log(`  ${page.url} — ${chunkCount} chunk(s)`)
    } catch (cause) {
      // One page failing to embed must not lose the rest of the site. The source row records the
      // failure, and the operator sees it here and in the panel.
      result.skipped.push({ url: page.url, reason: cause instanceof Error ? cause.message : String(cause) })
      log(`  ${page.url} — failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  if (result.skipped.length > 0) {
    // Named rather than counted. "Three pages skipped" invites a shrug; the reasons invite a fix.
    log(`skipped ${result.skipped.length}:`)
    for (const s of result.skipped) log(`  ${s.url} — ${s.reason}`)
  }
  log(`indexed ${indexed} page(s)`)
  return { indexed, skipped: result.skipped.length }
}
