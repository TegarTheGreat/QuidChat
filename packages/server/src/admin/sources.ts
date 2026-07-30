import type { IncomingMessage, ServerResponse } from "node:http"
import { withTenant } from "@quidchat/db"
import { fetchPage, indexSource, UrlFetchError } from "@quidchat/ingest"
import { sql } from "drizzle-orm"
import { readJsonBody, resolveTenantOr404, rowsOf, sendJson, type AdminDeps } from "./shared.js"

// Part of the admin API. The router and the shared helpers live in `../admin.ts`.

export async function listSources(
  res: ServerResponse,
  deps: AdminDeps,
  params: URLSearchParams,
): Promise<void> {
  const tenantId = await resolveTenantOr404(res, deps.db, params.get("tenantSlug"))
  if (tenantId === null) return

  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    // The document's title, not just the URI. For pasted text the two are the same, but for a
    // page the URI is an address and the title is the name a customer sees attached to the
    // answer — and a list of bare URLs is not something an owner can recognise their own
    // content in. Falls back to the URI when indexing never got as far as a document.
    const result = await tx.execute(sql`
      SELECT s.id, s.kind, s.uri, s.status, s.error, s.last_indexed_at,
             coalesce(
               -- The documents table carries no timestamp, so this is a stable pick rather
               -- than the newest one; the two only differ if a source was re-indexed under a
               -- different name.
               (SELECT d.title FROM documents d
                 WHERE d.source_id = s.id
                 ORDER BY d.id
                 LIMIT 1),
               s.uri
             ) AS title
      FROM knowledge_sources s
      ORDER BY s.last_indexed_at DESC NULLS LAST, s.id
    `)
    return rowsOf(result)
  })
  sendJson(res, 200, {
    sources: rows.map((r) => ({
      id: r.id, kind: r.kind, uri: r.uri, title: r.title, status: r.status, error: r.error,
      lastIndexedAt: r.last_indexed_at,
    })),
  })
}

/**
 * Creates a `text` knowledge source and indexes it immediately, so its content is
 * retrievable through `/chat` as soon as this call returns — that round trip is the
 * whole point of this route, not a side effect of it.
 *
 * The source row is inserted through `withTenant` first (`status: "pending"`), then
 * `indexSource` (from `@quidchat/ingest`) takes it through `"indexing"` to `"ready"` or
 * `"error"`. An embedding failure there is `indexSource`'s own documented, asymmetric
 * failure contract — chunks are still written (findable by keyword, even with no
 * vector) and the row is left `status: "error"` with the message — so it is answered
 * here as a normal `201`, not a `500`: nothing about this request itself failed, and
 * the source row already carries the failure for the admin panel to show.
 */
export async function createTextSource(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return

  const { tenantSlug, title, text } = body
  if (typeof tenantSlug !== "string" || tenantSlug.length === 0) {
    sendJson(res, 400, { error: "tenantSlug is required" })
    return
  }
  if (typeof title !== "string" || title.length === 0) {
    sendJson(res, 400, { error: "title is required" })
    return
  }
  if (typeof text !== "string" || text.length === 0) {
    sendJson(res, 400, { error: "text is required" })
    return
  }

  const tenantId = await resolveTenantOr404(res, deps.db, tenantSlug)
  if (tenantId === null) return

  const { embeddingModel } = await deps.store.getTenantConfig(tenantId)

  const sourceId = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'text', ${title}, 'pending')
      RETURNING id
    `)
    return rowsOf(result)[0]!.id as string
  })

  try {
    const indexed = await indexSource({
      tenantId, sourceId, title, text, embeddingModel, store: deps.store, provider: deps.provider,
    })
    sendJson(res, 201, {
      sourceId, documentId: indexed.documentId, chunkCount: indexed.chunkCount, status: "ready",
    })
  } catch (e) {
    // Worth an operational log even though the visitor-facing (here, admin-facing)
    // response stays clean — an embedding provider failing is something an operator
    // should notice, not just something a business owner eventually spots on the
    // sources list.
    deps.logError("indexSource failed for a text source", e)
    const message = e instanceof Error ? e.message : String(e)
    sendJson(res, 201, { sourceId, status: "error", error: message })
  }
}

/**
 * `POST /admin/sources/url` — read a page and index it.
 *
 * The fetch happens BEFORE the source row is created. A page that cannot be read produces no
 * row at all, rather than a permanent `error` row an owner has to find and delete after
 * mistyping a URL. That is the opposite of the text route's ordering, and deliberately so:
 * there, the text is already in hand and only the embedding can fail, so the row is worth
 * keeping to explain the failure and allow a retry.
 *
 * A failed URL is a `400` with the fetcher's own message — "resolves to a private address",
 * "is application/pdf", "has no readable text, paste it instead" — because each of those tells
 * the owner what to do next, and a generic failure tells them nothing.
 */
export async function createUrlSource(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : null,
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (body.url.trim() === "") {
    sendJson(res, 400, { error: "url is required" })
    return
  }

  let page: Awaited<ReturnType<typeof fetchPage>>
  try {
    page = await fetchPage(body.url.trim())
  } catch (e) {
    if (e instanceof UrlFetchError) {
      sendJson(res, 400, { error: e.message })
      return
    }
    deps.logError("fetching a URL source failed unexpectedly", e)
    sendJson(res, 502, { error: "could not read that page" })
    return
  }

  // The owner's own title wins when they gave one: a page titled "Home | Acme" is worse for
  // them to recognise in a citation than "Delivery terms".
  const title = body.title?.trim() || page.title
  const { embeddingModel } = await deps.store.getTenantConfig(tenantId)

  const sourceId = await withTenant(deps.db, tenantId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO knowledge_sources (tenant_id, kind, uri, status)
      VALUES (${tenantId}, 'url', ${page.finalUrl}, 'pending')
      RETURNING id
    `)
    return rowsOf(result)[0]!.id as string
  })

  try {
    const indexed = await indexSource({
      tenantId, sourceId, title, url: page.finalUrl, text: page.text,
      embeddingModel, store: deps.store, provider: deps.provider,
    })
    sendJson(res, 201, {
      sourceId, documentId: indexed.documentId, chunkCount: indexed.chunkCount,
      title, url: page.finalUrl, status: "ready",
    })
  } catch (e) {
    deps.logError("indexSource failed for a URL source", e)
    sendJson(res, 201, {
      sourceId, title, url: page.finalUrl,
      status: "error", error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * `DELETE /admin/sources` — remove a knowledge source and everything derived from it.
 *
 * Knowledge could be added and never removed, which for this product is not a missing
 * convenience: the assistant answers strictly from its sources, so a price list that is out of
 * date or a page indexed by mistake becomes wrong answers with a citation attached, and
 * confidently wrong is the one failure mode QuidChat exists to prevent.
 *
 * The documents and chunks follow by cascade. So do the citation rows on past messages, since
 * `message_citations` references `chunks` — the answer text a customer received stays in the
 * transcript, but it stops claiming to be backed by a chunk that no longer exists. That is
 * the honest outcome: keeping the link would point at nothing.
 */
export async function deleteSource(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  const raw = await readJsonBody(req, res)
  if (!raw) return
  const body = {
    tenantSlug: typeof raw.tenantSlug === "string" ? raw.tenantSlug : null,
    id: typeof raw.id === "string" ? raw.id : "",
  }

  const tenantId = await resolveTenantOr404(res, deps.db, body.tenantSlug)
  if (tenantId === null) return
  if (!body.id) {
    sendJson(res, 400, { error: "id is required" })
    return
  }

  const removed = await withTenant(deps.db, tenantId, async (tx) => {
    // Counted before the delete, because RETURNING on the source row cannot report what the
    // cascade took with it — and how much knowledge just disappeared is the one number the
    // person clicking the button wants confirmed.
    const chunkCount = Number(
      rowsOf(
        await tx.execute(sql`
          SELECT count(*)::int AS n
          FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE d.source_id = ${body.id}
        `),
      )[0]!.n,
    )
    const deleted = rowsOf(
      await tx.execute(sql`DELETE FROM knowledge_sources WHERE id = ${body.id} RETURNING id`),
    )[0]
    return deleted ? { chunkCount } : null
  })

  // Another tenant's id is invisible under RLS, so it arrives here as "not found" — the same
  // answer an id that never existed gets, which is also the only answer that does not confirm
  // to a caller that someone else's source exists.
  if (!removed) {
    sendJson(res, 404, { error: "source not found" })
    return
  }
  sendJson(res, 200, { ok: true, chunksRemoved: removed.chunkCount })
}
