import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"
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
export async function handleWidgetAsset(res: ServerResponse): Promise<void> {
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
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    // Long-lived and immutable: the bundle has no content hash in its filename, but it
    // is only ever replaced by a fresh `pnpm build` + deploy, not mutated in place.
    "cache-control": "public, max-age=31536000, immutable",
  })
  res.end(body)
}
