import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/**
 * Path to the widget's built IIFE bundle, resolved relative to THIS file rather than
 * `process.cwd()` — a server started from any working directory must still find it.
 * `packages/widget/dist/index.iife.js` sits two levels up from both `src/` (dev) and
 * `dist/` (built) here, since both are one directory deep under `packages/server`.
 */
const WIDGET_BUNDLE_PATH = fileURLToPath(new URL("../../widget/dist/index.iife.js", import.meta.url))

/**
 * Serves the built widget script at `GET /quidchat.js`.
 *
 * Public and unauthenticated, with no origin check — unlike `/chat`, this is a static
 * asset (the `<script src>` tag itself), not the endpoint the origin allowlist exists
 * to protect.
 *
 * A missing bundle answers `503`, not `404`. A `404` here looks exactly like a
 * customer's site linking to the wrong path; a `503` that names the missing file and
 * the fix says what is actually wrong — the widget package hasn't been built yet — so a
 * silent 404 never gets mistaken for "the widget is broken" when it's really "nobody
 * ran `pnpm build`".
 */
export async function handleWidgetAsset(
  res: ServerResponse,
  req?: IncomingMessage,
): Promise<void> {
  let body: Buffer
  try {
    body = await readFile(WIDGET_BUNDLE_PATH)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 503, {
        error:
          "widget bundle not built: packages/widget/dist/index.iife.js is missing — run `pnpm build`",
      })
      return
    }
    throw e
  }
  // The embed snippet is a fixed `<script src=".../quidchat.js">`, so the URL never changes
  // when the bundle does. This was served `immutable, max-age=31536000` on the reasoning that a
  // deploy replaces the file rather than mutating it — but a browser caches by URL, not by
  // inode. Every site that had ever loaded the widget would keep a year-old copy and never
  // receive a fix, security or otherwise. Found because a rebuilt bundle would not appear in a
  // browser that had already visited the page.
  //
  // An ETag over the bytes plus revalidation is the shape that fits a stable URL: unchanged
  // bundles cost a 304 with no body, and a new one lands on the next page load.
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`

  if (req?.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": "public, max-age=300, must-revalidate" })
    res.end()
    return
  }

  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    etag,
    "cache-control": "public, max-age=300, must-revalidate",
  })
  res.end(body)
}
