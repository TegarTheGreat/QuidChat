import type { Provider, Store } from "@quidchat/core"
import { chunkText, type ChunkOptions } from "./chunk.js"

export type IndexSourceResult = {
  documentId: string
  chunkCount: number
}

/**
 * Chunks a knowledge source's text, embeds each chunk, and writes the resulting
 * document and chunk rows through `store`. This is what makes a business's content
 * actually reachable by the assistant: `searchChunks` can only ever find what landed
 * here first.
 *
 * **Failure contract — deliberate and asymmetric, mirroring the pipeline's.**
 *
 * If any embedding call fails, every chunk is still written — the ones already
 * embedded keep their vector, and the rest (including the one that failed) are written
 * with `embedding: null`. Once one call has failed, the remaining chunks are not even
 * attempted: a provider that just failed is presumably still down, so spending more
 * calls on it buys nothing.
 *
 * A chunk with text and no vector is still findable through the keyword path, because
 * `searchChunks` fuses the keyword and vector paths by rank rather than requiring both
 * to succeed. Discarding those chunks — "clean up the partial write" — would look like
 * an improvement and would actually throw away content the business already gave us,
 * for a failure that has nothing to do with the text itself.
 *
 * The source's status is then set to `"error"` with the failure's message, and the
 * error is RETHROWN. A source left silently `"pending"` is invisible: the business
 * owner sees no error and no content, with no way to tell slow apart from broken.
 * Writing the failure onto the row is what lets the admin panel say "this failed, here
 * is why, retry" — the rethrow is what lets the caller notice right away instead of
 * only via that row.
 *
 * On success, the source's status is set to `"ready"` and its `last_indexed_at` is
 * refreshed.
 */
export async function indexSource(args: {
  tenantId: string
  sourceId: string
  title: string
  url?: string
  text: string
  embeddingModel: string
  store: Store
  provider: Provider
  chunkOptions?: ChunkOptions
}): Promise<IndexSourceResult> {
  const { tenantId, sourceId, title, text, embeddingModel, store, provider, chunkOptions } = args

  await store.setSourceStatus({ tenantId, sourceId, status: "indexing" })

  const documentId = await store.createDocument({
    tenantId,
    sourceId,
    title,
    ...(args.url !== undefined ? { url: args.url } : {}),
  })

  const pieces = chunkText(text, chunkOptions)

  const chunks: {
    ordinal: number
    content: string
    embedding: number[] | null
    embeddingModel: string
  }[] = []
  let embedError: unknown = null

  for (const piece of pieces) {
    if (embedError) {
      // A previous chunk in this same batch already failed to embed. See the doc
      // comment above: the text is still written so it stays findable by keyword,
      // but no further embedding calls are made against a provider that just failed.
      chunks.push({ ordinal: piece.ordinal, content: piece.content, embedding: null, embeddingModel })
      continue
    }
    try {
      const embedding = await provider.embed({ model: embeddingModel, text: piece.content })
      chunks.push({ ordinal: piece.ordinal, content: piece.content, embedding, embeddingModel })
    } catch (err) {
      embedError = err
      chunks.push({ ordinal: piece.ordinal, content: piece.content, embedding: null, embeddingModel })
    }
  }

  if (chunks.length > 0) {
    await store.insertChunks({ tenantId, documentId, chunks })
  }

  if (embedError) {
    const message = embedError instanceof Error ? embedError.message : String(embedError)
    await store.setSourceStatus({ tenantId, sourceId, status: "error", error: message })
    throw embedError
  }

  await store.setSourceStatus({ tenantId, sourceId, status: "ready" })
  return { documentId, chunkCount: chunks.length }
}
