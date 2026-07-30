import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * Fetches a page and reduces it to the text worth indexing.
 *
 * This is the feature a business asks for first — "just read my website" — and it is also
 * the most dangerous thing in the product, because it makes the server issue HTTP requests
 * to an address someone else chose. On a managed host that address can be the cloud
 * provider's metadata endpoint or a database on the same private network, and the reply
 * would be chunked, embedded and then readable through the assistant. Every guard below
 * exists for that reason and not for tidiness.
 */

export type FetchedPage = {
  /** The page's own title, or the URL when it has none worth using. */
  title: string
  text: string
  /** The URL actually fetched, after redirects. Stored so a source can be re-read later. */
  finalUrl: string
  /**
   * The body as it arrived, when it was HTML.
   *
   * Kept only because a crawler needs the links, which `text` has already thrown away. Nothing
   * indexes this — the chunker takes `text` — so it costs memory for the length of one crawl and
   * nothing after it.
   */
  html?: string
}

export class UrlFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UrlFetchError"
  }
}

/** Bounded so one hostile page cannot exhaust memory or hold a request open. */
const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

/**
 * True for addresses that must never be fetched on a user's behalf.
 *
 * Loopback and the private ranges are the obvious ones. `169.254.0.0/16` is the important
 * one: `169.254.169.254` is the instance metadata endpoint on AWS, GCP and Azure alike, and
 * on an unprotected instance it hands out credentials to anything that asks. `0.0.0.0/8`,
 * carrier-grade NAT and IPv6 unique-local are here because each is reachable from inside a
 * typical deployment and none is ever a business's public website.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === "::1" || lower === "::") return true
    // fc00::/7 (unique local) and fe80::/10 (link local).
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true
    // An IPv4-mapped address is an IPv4 address wearing a hat; unwrap it rather than
    // letting `::ffff:127.0.0.1` walk past the IPv4 rules below.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    return mapped ? isBlockedAddress(mapped[1]!) : false
  }
  if (family !== 4) return true

  const parts = address.split(".").map(Number)
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/**
 * Resolves the host and rejects it if any answer is a blocked address.
 *
 * Checked on EVERY hop rather than once at the start, because a redirect is a second chance
 * to name a target: a public URL answering `302 http://169.254.169.254/` would otherwise
 * defeat a check that only ran on the URL the user typed.
 *
 * A name resolving to several addresses is rejected when ANY of them is blocked. `fetch`
 * chooses which one to connect to and we cannot see or constrain that choice, so allowing
 * the request because one answer looked fine would be leaving it to luck.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const literal = isIP(hostname)
  if (literal) {
    if (isBlockedAddress(hostname)) {
      throw new UrlFetchError(`refusing to fetch a private or local address: ${hostname}`)
    }
    return
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new UrlFetchError(`could not resolve ${hostname}`)
  }
  const blocked = addresses.find((a) => isBlockedAddress(a.address))
  if (blocked) {
    throw new UrlFetchError(
      `${hostname} resolves to a private or local address (${blocked.address}) and will not be fetched`,
    )
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", eacute: "é", copy: "©", reg: "®", deg: "°",
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // A codepoint outside Unicode, or a lone surrogate, would make `fromCodePoint` throw
      // and take the whole ingest down over one malformed page.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Reduces HTML to the prose a customer question could be answered from.
 *
 * `script`, `style`, `noscript`, `template` and `svg` are removed with their contents
 * because their contents are not language: indexing a page's JavaScript produces chunks that
 * match nothing a customer would ever type, while spending an embedding call on each.
 * `nav`, `header`, `footer` and `aside` go too — a menu repeated on ninety pages becomes
 * ninety near-identical chunks that crowd the real answer out of the retrieval window.
 *
 * Block-level tags become newlines rather than nothing, because the chunker splits on
 * paragraphs. Flattening the whole page into one line would leave it with nothing to split
 * on and force it into the mid-sentence fallback.
 */
export function htmlToText(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "")
  // The head holds the title, meta description and inline assets. `extractTitle` reads the
  // title from the raw HTML, so leaving the head in here would prepend it to the body text of
  // every single page — the same words indexed twice, once as the source's own name.
  out = out.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
  out = out.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
  out = out.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  out = out.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  out = out.replace(/<(p|div|section|article|br|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n")
  out = out.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
  out = out.replace(/<[^>]+>/g, " ")
  out = decodeEntities(out)
  // Collapse runs of spaces and tabs, but keep paragraph breaks — see above.
  out = out.replace(/[ \t ]+/g, " ")
  out = out.replace(/\n[ \t]+/g, "\n").replace(/[ \t]+\n/g, "\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  return out.trim()
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  const title = decodeEntities(match[1]!).replace(/\s+/g, " ").trim()
  return title.length > 0 ? title : null
}

/**
 * Fetches one page, following a bounded number of redirects by hand.
 *
 * Redirects are followed manually — `redirect: "manual"` — for one reason: `fetch`'s own
 * redirect handling would connect to the next hop before we could check where it points, and
 * that check is the whole defence. Manual following costs a few lines and is what makes the
 * per-hop address check possible at all.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    throw new UrlFetchError(`not a valid URL: ${rawUrl}`)
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // `file:` would read the server's disk and `gopher:`/`ftp:` reach services that respond
    // to anything; an allowlist of two schemes is the only safe shape here.
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new UrlFetchError(`only http and https URLs can be fetched, not ${current.protocol}`)
    }
    await assertPublicHost(current.hostname)

    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Named honestly. A site owner reading their logs should be able to tell what is
        // reading their pages, and a crawler that lies about itself is one nobody can block.
        "user-agent": "QuidChat/1.0 (+https://github.com/TegarTheGreat/QuidChat)",
        accept: "text/html,text/plain;q=0.9",
      },
    }).catch((cause: unknown) => {
      throw new UrlFetchError(
        cause instanceof Error && cause.name === "TimeoutError"
          ? `${current.href} did not respond within ${TIMEOUT_MS / 1000} seconds`
          : `could not reach ${current.href}`,
      )
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) throw new UrlFetchError(`${current.href} redirected without a destination`)
      current = new URL(location, current)
      continue
    }

    if (!response.ok) {
      throw new UrlFetchError(`${current.href} returned HTTP ${response.status}`)
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    // A PDF or an image would be chunked as binary noise and embedded as gibberish, which
    // costs real money and makes retrieval worse. Refusing with the type named tells the
    // owner what to do instead.
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && contentType !== "") {
      throw new UrlFetchError(
        `${current.href} is ${contentType.split(";")[0]}, and only HTML and plain text can be read`,
      )
    }

    return readablePage({
      body: await readBounded(response),
      contentType,
      url: current.href,
    })
  }

  throw new UrlFetchError(`${rawUrl} redirected more than ${MAX_REDIRECTS} times`)
}

/**
 * Turns a fetched body into the page to index, or explains why it cannot be one.
 *
 * Separate from `fetchPage` and exported so these decisions can be tested against exact
 * inputs. The alternative was an option on `fetchPage` that skipped the address check for
 * tests, and a security control with a documented bypass is one line away from being bypassed
 * in production — the guard has no way in at all, and this has no network.
 */
export function readablePage(args: { body: string; contentType: string; url: string }): FetchedPage {
  const { body, contentType, url } = args
  // A server that omits `content-type` is common enough to handle: sniff the markup rather
  // than refusing a page that would have read perfectly well.
  const isHtml = contentType.includes("text/html") || /<html|<body|<div|<p[\s>]/i.test(body)
  const text = isHtml ? htmlToText(body) : body.trim()
  if (text.length === 0) {
    // Almost always a page that renders its content with JavaScript. Saying so saves the
    // owner from concluding QuidChat is broken.
    throw new UrlFetchError(
      `${url} has no readable text — if the page builds its content in the browser, paste the text instead`,
    )
  }
  return {
    title: (isHtml ? extractTitle(body) : null) ?? url,
    text,
    finalUrl: url,
    ...(isHtml ? { html: body } : {}),
  }
}

/**
 * Reads the body, stopping at `MAX_BYTES`.
 *
 * The bound is applied while the bytes arrive rather than to the finished string, because a
 * `Content-Length` can lie and a chunked response has none at all — checking the total after
 * buffering means the unbounded buffer has already happened.
 */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new UrlFetchError(`page is larger than ${MAX_BYTES / 1024 / 1024} MB`)
      }
      chunks.push(value)
    }
  }
  return new TextDecoder("utf-8").decode(concat(chunks, size))
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
