import { describe, expect, it } from "vitest"
import {
  extractTitle,
  fetchPage,
  htmlToText,
  isBlockedAddress,
  readablePage,
  UrlFetchError,
} from "./fetch-url.js"

describe("isBlockedAddress", () => {
  it("blocks every range that is reachable from inside a deployment", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "0.0.0.0", "100.64.0.1", "224.0.0.1",
      // The one that actually leaks credentials: instance metadata on AWS, GCP and Azure.
      "169.254.169.254",
      "::1", "fd00::1", "fe80::1",
      // An IPv4-mapped address must be unwrapped, not waved through as "some IPv6 thing".
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
  })

  it("allows ordinary public addresses", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:2800::1"]) {
      expect(isBlockedAddress(address), address).toBe(false)
    }
  })

  it("blocks anything that is not an IP address at all", () => {
    // Reached only if a caller passes something unresolved; failing closed is the only safe
    // answer, since "not an address I recognise" is not evidence that it is public.
    expect(isBlockedAddress("not-an-ip")).toBe(true)
  })
})

describe("htmlToText", () => {
  it("drops code and chrome, and keeps paragraph breaks", () => {
    const text = htmlToText(`
      <html><head><title>Shop</title><style>.a{color:red}</style></head>
      <body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <p>Returns are accepted within seven days.</p>
        <p>Warranty is one year.</p>
        <script>track("pageview")</script>
        <footer>Copyright 2026</footer>
      </body></html>`)

    expect(text).toContain("Returns are accepted within seven days.")
    expect(text).toContain("Warranty is one year.")
    // Script and style contents are not language: they match nothing a customer types and
    // cost an embedding call each.
    expect(text).not.toContain("track")
    expect(text).not.toContain("color:red")
    // A menu repeated on every page becomes near-identical chunks that crowd out real answers.
    expect(text).not.toContain("About")
    expect(text).not.toContain("Copyright")
    // The chunker splits on paragraphs, so the break between them has to survive.
    expect(text).toMatch(/seven days\.\s*\n+\s*Warranty/)
  })

  it("decodes entities, including numeric ones, and leaves malformed ones alone", () => {
    expect(htmlToText("<p>Fish &amp; chips &mdash; Rp&nbsp;25.000</p>")).toBe("Fish & chips — Rp 25.000")
    expect(htmlToText("<p>&#82;&#x70; 10</p>")).toBe("Rp 10")
    // A codepoint outside Unicode would make fromCodePoint throw and take the whole ingest
    // down over one malformed page.
    expect(htmlToText("<p>&#99999999; &notareal;</p>")).toBe("&#99999999; &notareal;")
  })
})

describe("extractTitle", () => {
  it("reads and cleans the title, and reports its absence", () => {
    expect(extractTitle("<title>  My   Shop\n</title>")).toBe("My Shop")
    expect(extractTitle("<title></title>")).toBeNull()
    expect(extractTitle("<html><body>hi</body></html>")).toBeNull()
  })
})

describe("readablePage", () => {
  it("reads HTML, taking the title from the page", () => {
    const page = readablePage({
      body: "<html><head><title>Shop</title></head><body><p>Open daily.</p></body></html>",
      contentType: "text/html; charset=utf-8",
      url: "https://shop.example/",
    })
    expect(page).toMatchObject({
      title: "Shop",
      text: "Open daily.",
      finalUrl: "https://shop.example/",
    })
    // The raw body comes back too, because a crawler needs the links that `text` has thrown
    // away. Nothing indexes it.
    expect(page.html).toContain("<title>Shop</title>")
  })

  it("falls back to the URL when the page has no title", () => {
    const page = readablePage({
      body: "Open daily.",
      contentType: "text/plain",
      url: "https://shop.example/hours.txt",
    })
    expect(page.title).toBe("https://shop.example/hours.txt")
  })

  it("treats markup as HTML when the server sent no content type", () => {
    // Common enough to handle rather than refuse a page that reads perfectly well.
    const page = readablePage({
      body: "<div><p>Open daily.</p><script>x()</script></div>",
      contentType: "",
      url: "https://shop.example/",
    })
    expect(page.text).toBe("Open daily.")
  })

  it("says what to do when a page renders its text in the browser", () => {
    expect(() =>
      readablePage({
        body: "<html><body><div id='root'></div><script>render()</script></body></html>",
        contentType: "text/html",
        url: "https://shop.example/",
      }),
    ).toThrow(/paste the text instead/)
  })
})

describe("fetchPage", () => {
  it("refuses a scheme that would read the server's own disk", async () => {
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow(UrlFetchError)
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow(/only http and https/)
  })

  it("refuses a literal private address before making any request", async () => {
    await expect(fetchPage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /private or local address/,
    )
  })

  it("refuses a hostname that resolves to loopback", async () => {
    // The realistic attack: a public name whose DNS record points inside the network.
    await expect(fetchPage("http://localhost:1/")).rejects.toThrow(/private or local address/)
  })

  it("rejects a URL that is not one", async () => {
    await expect(fetchPage("shop.example/prices")).rejects.toThrow(/not a valid URL/)
  })
})
