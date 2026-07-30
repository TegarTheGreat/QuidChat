import { fetchPage, UrlFetchError, type FetchedPage } from "./fetch-url.js"

/**
 * Reads a whole site, not one page at a time.
 *
 * "Point it at my website" is what a business actually asks for, and until now the answer was to
 * add every page by hand. A shop with a delivery page, a returns page, a warranty page and an FAQ
 * had to find and paste four URLs, and would never notice when a fifth appeared.
 *
 * Three rules keep this from being a nuisance to the site it is reading:
 *
 * It stays on the origin it was given. A link to Facebook or a payment provider is not this
 * business's content, and following it would index somebody else's words as if the business had
 * said them — which is precisely the failure the whole product exists to prevent.
 *
 * It obeys robots.txt. A crawler that ignores it is one site owners block, and QuidChat is
 * reading on behalf of the owner rather than around them.
 *
 * It is bounded. A page count, and the per-page guards in `fetchPage` — no private addresses, no
 * redirects into them, a size limit and a timeout — which matter more here because the URLs come
 * from the site rather than from a person.
 */

export type CrawledPage = FetchedPage & { url: string }

export type CrawlResult = {
  pages: CrawledPage[]
  /** What was skipped and why, so an owner can see the site was read rather than guess. */
  skipped: { url: string; reason: string }[]
}

const DEFAULT_MAX_PAGES = 25

/**
 * Pulls same-origin page links out of HTML.
 *
 * Deliberately crude — an `href` regex rather than a parser — because the only thing being
 * decided is what to fetch next, and a missed link costs one page while a parser costs a
 * dependency shipped to every install.
 */
export function extractLinks(html: string, base: string): string[] {
  const origin = new URL(base).origin
  const found = new Set<string>()

  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!
    // Anchors, mail links, telephone links and javascript: are not pages.
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue

    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (resolved.origin !== origin) continue
    // The fragment is the same page, and keeping it would fetch that page once per heading.
    resolved.hash = ""
    // Assets a crawler has no use for. Anything without an extension is assumed to be a page,
    // which is right far more often than not.
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|mp4|mp3|woff2?)$/i.test(resolved.pathname)) continue
    found.add(resolved.href)
  }
  return [...found]
}

/** The `<loc>` entries of a sitemap, which is a list of exactly the pages an owner wants found. */
export function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!)
}

/**
 * The paths robots.txt forbids for us.
 *
 * Only `Disallow`, and only from the groups that apply to this crawler — the wildcard group and
 * one naming QuidChat. Prefix matching, which is what the convention actually specifies; the
 * wildcard and `$` extensions are not handled, and a rule using them is treated as a plain prefix,
 * which errs towards fetching less rather than more.
 */
export function disallowedPaths(robotsTxt: string, userAgent = "quidchat"): string[] {
  const disallowed: string[] = []
  let applies = false

  for (const raw of robotsTxt.split("\n")) {
    const line = raw.split("#")[0]!.trim()
    if (line === "") continue
    const [field, ...rest] = line.split(":")
    const key = field!.trim().toLowerCase()
    const value = rest.join(":").trim()

    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase() === userAgent
      continue
    }
    if (applies && key === "disallow" && value !== "") disallowed.push(value)
  }
  return disallowed
}

function isAllowed(url: string, disallowed: string[]): boolean {
  const path = new URL(url).pathname
  return !disallowed.some((rule) => path.startsWith(rule.replace(/\*.*$/, "")))
}

/**
 * Reads up to `maxPages` pages, starting from a URL or a sitemap.
 *
 * Breadth-first: a site's most important pages are the ones its front page links to, so when the
 * budget runs out it runs out on the deepest pages rather than on the ones a customer asks about.
 */
export async function crawlSite(args: {
  startUrl: string
  maxPages?: number
  /** Injected by tests. Production passes nothing and gets the real guarded fetcher. */
  fetchPageImpl?: typeof fetchPage
  fetchImpl?: typeof fetch
}): Promise<CrawlResult> {
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES
  const readPage = args.fetchPageImpl ?? fetchPage
  const doFetch = args.fetchImpl ?? fetch

  const start = new URL(args.startUrl)
  const pages: CrawledPage[] = []
  const skipped: { url: string; reason: string }[] = []

  let disallowed: string[] = []
  try {
    const robots = await doFetch(new URL("/robots.txt", start).href, {
      signal: AbortSignal.timeout(10_000),
    })
    if (robots.ok) disallowed = disallowedPaths(await robots.text())
  } catch {
    // No robots.txt, or unreachable. Absence permits, which is what the convention says.
  }

  // A sitemap is a list of exactly the pages an owner wants found, so it beats guessing from
  // links. Recognised by name rather than content type, which servers get wrong constantly.
  let queue: string[]
  if (/sitemap[^/]*\.xml$/i.test(start.pathname)) {
    const res = await doFetch(start.href, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new UrlFetchError(`${start.href} returned HTTP ${res.status}`)
    queue = extractSitemapUrls(await res.text()).filter((u) => new URL(u).origin === start.origin)
  } else {
    queue = [start.href]
  }

  const seen = new Set<string>(queue)
  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!
    if (!isAllowed(url, disallowed)) {
      skipped.push({ url, reason: "robots.txt disallows it" })
      continue
    }

    let page: CrawledPage
    try {
      page = { ...(await readPage(url)), url }
    } catch (cause) {
      // One unreadable page must not end the crawl: a site with a PDF in its menu, or one page
      // that renders in the browser, is completely ordinary.
      skipped.push({ url, reason: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    pages.push(page)

    // Only follow links when crawling from a page. A sitemap already said what it wanted read,
    // and treating it as a starting point instead would ignore that.
    if (queue.length + pages.length < maxPages && !/sitemap[^/]*\.xml$/i.test(start.pathname)) {
      for (const link of extractLinks(page.html ?? "", url)) {
        if (!seen.has(link)) {
          seen.add(link)
          queue.push(link)
        }
      }
    }
  }

  return { pages, skipped }
}
