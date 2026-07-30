import { describe, expect, it } from "vitest"
import { crawlSite, disallowedPaths, extractLinks, extractSitemapUrls } from "./crawl.js"
import type { FetchedPage } from "./fetch-url.js"

const page = (url: string, html: string): FetchedPage => ({
  title: "Page",
  text: "some readable text",
  finalUrl: url,
  html,
})

describe("extractLinks", () => {
  it("takes same-origin pages and nothing else", () => {
    const html = `
      <a href="/delivery">Delivery</a>
      <a href="returns">Returns</a>
      <a href="https://shop.example/warranty">Warranty</a>
      <a href="https://facebook.com/shop">Facebook</a>
      <a href="#top">Top</a>
      <a href="mailto:hi@shop.example">Mail</a>
      <a href="/logo.png">Logo</a>
      <a href="/delivery#terms">Terms</a>`
    const links = extractLinks(html, "https://shop.example/")

    expect(links).toContain("https://shop.example/delivery")
    expect(links).toContain("https://shop.example/returns")
    expect(links).toContain("https://shop.example/warranty")
    // Somebody else's words indexed as if this business had said them is the failure the whole
    // product exists to prevent.
    expect(links.some((l) => l.includes("facebook"))).toBe(false)
    expect(links.some((l) => l.endsWith(".png"))).toBe(false)
    // A fragment is the same page; keeping it would fetch that page once per heading.
    expect(links.filter((l) => l.startsWith("https://shop.example/delivery"))).toEqual([
      "https://shop.example/delivery",
    ])
  })
})

describe("disallowedPaths", () => {
  it("reads the groups that apply to this crawler", () => {
    const robots = `
      User-agent: badbot
      Disallow: /

      User-agent: *
      Disallow: /cart
      Disallow: /checkout   # no point reading these

      User-agent: quidchat
      Disallow: /admin`
    const rules = disallowedPaths(robots)
    expect(rules).toContain("/cart")
    expect(rules).toContain("/checkout")
    expect(rules).toContain("/admin")
    // The rule aimed at another crawler is not ours to obey.
    expect(rules).not.toContain("/")
  })
})

describe("extractSitemapUrls", () => {
  it("reads the locations", () => {
    const xml = `<urlset><url><loc>https://shop.example/a</loc></url>
      <url><loc> https://shop.example/b </loc></url></urlset>`
    expect(extractSitemapUrls(xml)).toEqual(["https://shop.example/a", "https://shop.example/b"])
  })
})

describe("crawlSite", () => {
  const site: Record<string, string> = {
    "https://shop.example/": '<a href="/delivery">d</a><a href="/returns">r</a>',
    "https://shop.example/delivery": '<a href="/warranty">w</a><a href="/">home</a>',
    "https://shop.example/returns": "<p>returns</p>",
    "https://shop.example/warranty": "<p>warranty</p>",
    "https://shop.example/cart": "<p>cart</p>",
  }
  const fetchPageImpl = (async (url: string) => {
    if (!(url in site)) throw new Error(`404 ${url}`)
    return page(url, site[url]!)
  }) as never

  const noRobots = (async () => new Response("", { status: 404 })) as unknown as typeof fetch

  it("follows the site's own links and reads each page once", async () => {
    const result = await crawlSite({
      startUrl: "https://shop.example/",
      fetchPageImpl,
      fetchImpl: noRobots,
    })
    expect(result.pages.map((p) => p.url).toSorted()).toEqual([
      "https://shop.example/",
      "https://shop.example/delivery",
      "https://shop.example/returns",
      "https://shop.example/warranty",
    ])
  })

  it("stops at the page budget", async () => {
    const result = await crawlSite({
      startUrl: "https://shop.example/",
      maxPages: 2,
      fetchPageImpl,
      fetchImpl: noRobots,
    })
    expect(result.pages).toHaveLength(2)
    // Breadth-first, so the budget runs out on the deepest pages rather than the ones a customer
    // is most likely to ask about.
    expect(result.pages[0]!.url).toBe("https://shop.example/")
  })

  it("obeys robots.txt, and says what it skipped", async () => {
    const robots = (async (url: string) =>
      url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nDisallow: /returns", { status: 200 })
        : new Response("", { status: 404 })) as unknown as typeof fetch

    const result = await crawlSite({
      startUrl: "https://shop.example/",
      fetchPageImpl,
      fetchImpl: robots,
    })
    expect(result.pages.map((p) => p.url)).not.toContain("https://shop.example/returns")
    // Reported rather than silently dropped: an owner wondering why a page is missing should be
    // able to see that their own robots.txt is the reason.
    expect(result.skipped.some((s) => s.reason.includes("robots"))).toBe(true)
  })

  it("carries on when one page cannot be read", async () => {
    const withBroken = (async (url: string) => {
      if (url === "https://shop.example/returns") throw new Error("is application/pdf")
      if (!(url in site)) throw new Error(`404 ${url}`)
      return page(url, site[url]!)
    }) as never

    const result = await crawlSite({
      startUrl: "https://shop.example/",
      fetchPageImpl: withBroken,
      fetchImpl: noRobots,
    })
    // A site with a PDF in its menu is completely ordinary; one unreadable page must not end the
    // crawl.
    expect(result.pages.length).toBeGreaterThan(1)
    expect(result.skipped.some((s) => s.reason.includes("pdf"))).toBe(true)
  })

  it("reads a sitemap as the list it is, without following links from it", async () => {
    const sitemap = (async (url: string) =>
      url.endsWith("sitemap.xml")
        ? new Response(
            "<urlset><url><loc>https://shop.example/returns</loc></url>" +
              "<url><loc>https://shop.example/warranty</loc></url>" +
              "<url><loc>https://elsewhere.example/x</loc></url></urlset>",
            { status: 200 },
          )
        : new Response("", { status: 404 })) as unknown as typeof fetch

    const result = await crawlSite({
      startUrl: "https://shop.example/sitemap.xml",
      fetchPageImpl,
      fetchImpl: sitemap,
    })
    // Exactly what the sitemap listed, minus another origin's page, and nothing discovered by
    // following links — the owner already said what they wanted read.
    expect(result.pages.map((p) => p.url).toSorted()).toEqual([
      "https://shop.example/returns",
      "https://shop.example/warranty",
    ])
  })
})
