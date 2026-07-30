import { applyMigrations, createDb, createStore, type QuidDb } from "@quidchat/db"
import { indexSource } from "@quidchat/ingest"
import { resolveProviders } from "@quidchat/providers"
import { sql } from "drizzle-orm"
import { readServeConfig } from "./config.js"

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res)
    ? (res as Record<string, unknown>[])
    : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

/**
 * Creates a `text` knowledge source for a tenant and indexes it.
 *
 * Like `initTenant`, the source row is created with the raw handle: the operator is
 * acting on behalf of a tenant they own, and there is no tenant context to adopt until
 * the tenant is known. Indexing itself goes through `Store`, so the chunk and document
 * writes are scoped by row-level security exactly as a request would be.
 */
export async function addText(args: {
  db: QuidDb
  env: Record<string, string | undefined>
  slug: string
  title: string
  text: string
  log?: (line: string) => void
}): Promise<{ documentId: string; chunkCount: number }> {
  const log = args.log ?? ((line: string) => console.log(line))

  if (args.text.trim().length === 0) {
    // Indexing empty text would produce zero chunks and report success, leaving the
    // operator believing content was added.
    throw new Error("the text to index is empty")
  }

  const tenant = rowsOf(
    await args.db.execute(sql`SELECT id FROM tenants WHERE slug = ${args.slug}`),
  )[0]
  if (!tenant) {
    throw new Error(
      `unknown tenant "${args.slug}" — run \`quidchat init ${args.slug} ...\` first`,
    )
  }
  const tenantId = tenant.id as string

  const resolved = resolveProviders(args.env)
  if (!resolved.provider) {
    throw new Error(
      "No usable AI provider found in the environment, and indexing needs one to " +
        "embed the text. Set a provider key and try again.",
    )
  }

  const config = await createStore(args.db).getTenantConfig(tenantId)

  const source = rowsOf(
    await args.db.execute(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${args.title}, 'pending')
      RETURNING id
    `),
  )[0]

  const result = await indexSource({
    store: createStore(args.db),
    provider: resolved.provider,
    tenantId,
    sourceId: source!.id as string,
    title: args.title,
    text: args.text,
    embeddingModel: config.embeddingModel,
  })

  log(`indexed "${args.title}" as ${result.chunkCount} chunk(s)`)
  return result
}

/** Opens the configured database, applies migrations, and runs `addText`. */
export async function runAddText(args: {
  env: Record<string, string | undefined>
  slug: string
  title: string
  text: string
  log?: (line: string) => void
}): Promise<{ documentId: string; chunkCount: number }> {
  const config = readServeConfig(args.env)
  const db = await createDb(config.db)
  await applyMigrations(db)
  return addText({ db, ...args })
}
