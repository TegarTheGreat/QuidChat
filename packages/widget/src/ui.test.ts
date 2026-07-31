// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { ChatResponse } from "./api.js"
import type { WidgetConfig } from "./config.js"
import { DEFAULT_THEME, sanitizeTheme } from "./theme.js"
import { mountWidget } from "./ui.js"

/**
 * The CSS actually applied to the widget, however it got there.
 *
 * The widget prefers a constructable stylesheet so a host page's `style-src 'self'` cannot leave
 * it unstyled, and falls back to a `<style>` element. A test that only looked for the element
 * would pass or fail on the mechanism rather than on the CSS.
 */
function stylesOf(container: HTMLElement): string {
  const shadow = container.shadowRoot!
  const adopted = [...(shadow.adoptedStyleSheets ?? [])]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join("\n")
  return adopted || (shadow.querySelector("style")?.textContent ?? "")
}


/** Token counts are irrelevant to these tests; the shape just has to be present. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: null }

const cfg: WidgetConfig = { tenantSlug: "acme", apiBase: "https://api.example.test" }

/** A promise the test controls the resolution of, so it can assert on the widget's
 *  state WHILE a `sendMessage` call is still pending. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function mount(sendMessage: (...args: never[]) => Promise<ChatResponse>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  mountWidget(container, cfg, { sendMessage: sendMessage as never })
  const shadow = container.shadowRoot!

  const launcher = shadow.querySelector<HTMLButtonElement>('[aria-label="Open chat assistant"]')!
  const panel = shadow.querySelector<HTMLElement>('[role="dialog"]')!
  const input = shadow.querySelector<HTMLTextAreaElement>("textarea")!
  const sendButton = shadow.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
  const messageList = shadow.querySelector<HTMLElement>('[aria-live="polite"]')!

  function pressEnter(shiftKey: boolean): void {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }),
    )
  }

  async function send(text: string): Promise<void> {
    input.value = text
    pressEnter(false)
    // Let the microtask queue drain so the synchronous part of `submit()` (the
    // visitor bubble, the pending state) has run.
    await Promise.resolve()
  }

  return { shadow, launcher, panel, input, sendButton, messageList, pressEnter, send }
}

describe("widget UI", () => {
  it("shows the visitor's own message immediately, before the reply arrives", async () => {
    const { promise } = deferred<ChatResponse>()
    const { launcher, messageList, send } = mount(() => promise)

    launcher.click()
    await send("How long is the warranty?")

    expect(messageList.textContent).toContain("How long is the warranty?")
  })

  it("renders a refusal as a message, not as a thrown error", async () => {
    const { launcher, messageList, send } = mount(async () => ({
      conversationId: "c1",
      kind: "refused",
      text: "I don't have information about that.",
      reason: "no_source",
      usage: ZERO_USAGE,
    }))

    launcher.click()
    await send("Do you offer intergalactic teleportation?")
    await vi.waitFor(() => {
      expect(messageList.textContent).toContain("I don't have information about that.")
    })
  })

  it("renders a business_claim segment's source", async () => {
    const { launcher, messageList, send } = mount(async () => ({
      conversationId: "c1",
      kind: "answered",
      segments: [{ kind: "business_claim", text: "The warranty lasts 12 months.", citations: ["chunk-42"] }],
      citations: [{ chunkId: "chunk-42", documentTitle: "Warranty Policy" }],
      usage: ZERO_USAGE,
    }))

    launcher.click()
    await send("How long is the warranty?")
    await vi.waitFor(() => {
      expect(messageList.textContent).toContain("The warranty lasts 12 months.")
      // The DOCUMENT TITLE is shown, not the chunk id. A visitor recognises "Warranty
      // Policy"; a UUID tells them nothing, and would satisfy the letter of "show the
      // source" while defeating its purpose.
      expect(messageList.textContent).toContain("Warranty Policy")
      expect(messageList.textContent).not.toContain("chunk-42")
    })
  })

  it("renders no source for a general segment", async () => {
    const { launcher, messageList, send } = mount(async () => ({
      conversationId: "c1",
      kind: "answered",
      segments: [{ kind: "general", text: "Sure, happy to help!" }],
      citations: [], usage: ZERO_USAGE,
    }))

    launcher.click()
    await send("Hi there")
    await vi.waitFor(() => {
      expect(messageList.textContent).toContain("Sure, happy to help!")
    })
    expect(messageList.textContent).not.toContain("Source:")
  })

  it("disables the send button while a request is in flight, and re-enables it after", async () => {
    const { promise, resolve } = deferred<ChatResponse>()
    const { launcher, sendButton, messageList, send } = mount(() => promise)

    launcher.click()
    await send("Hi")

    expect(sendButton.disabled).toBe(true)
    expect(messageList.textContent).toContain("Assistant is typing")

    resolve({ conversationId: "c1", kind: "answered", segments: [], citations: [], usage: ZERO_USAGE })
    await vi.waitFor(() => {
      expect(sendButton.disabled).toBe(false)
    })
  })

  it("sends on Enter, but inserts a newline instead of sending on Shift+Enter", async () => {
    const sendMessage = vi.fn(async (): Promise<ChatResponse> => ({
      conversationId: "c1",
      kind: "answered",
      segments: [],
      citations: [], usage: ZERO_USAGE,
    }))
    const { launcher, input, pressEnter } = mount(sendMessage)

    launcher.click()
    input.value = "line one"
    pressEnter(true)
    await Promise.resolve()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(input.value).toBe("line one")

    pressEnter(false)
    await Promise.resolve()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("closes the panel on Escape", () => {
    const { launcher, panel, input } = mount(async () => ({
      conversationId: "c1",
      kind: "answered",
      segments: [],
      citations: [], usage: ZERO_USAGE,
    }))

    launcher.click()
    expect(panel.hidden).toBe(false)

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(panel.hidden).toBe(true)
  })

  it("focuses the input when the panel opens", () => {
    const { shadow, launcher, input } = mount(async () => ({
      conversationId: "c1",
      kind: "answered",
      segments: [],
      citations: [], usage: ZERO_USAGE,
    }))

    launcher.click()
    expect(shadow.activeElement).toBe(input)
  })
})

describe("widget theming", () => {
  it("renders fully with the default theme when none is provided, as when a theme fetch fails", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    mountWidget(container, cfg)
    const shadow = container.shadowRoot!

    expect(shadow.querySelector('[role="dialog"]')).not.toBeNull()
    expect(shadow.querySelector(".header-title")!.textContent).toBe(DEFAULT_THEME.title)
  })

  it("never lets a hostile primaryColor reach the stylesheet", () => {
    // Stands in for a value an operator typed into the admin's raw-JSON theme editor:
    // `sanitizeTheme` is the boundary that must catch it before `mountWidget` ever
    // interpolates a theme value into CSS text.
    const hostileTheme = sanitizeTheme({
      primaryColor: "red; } .evil { position: fixed; top: 0; left: 0",
      position: "left",
      title: "Acme Support",
    })
    const container = document.createElement("div")
    document.body.appendChild(container)
    mountWidget(container, cfg, undefined, hostileTheme)

    const styleText = stylesOf(container)
    expect(styleText).not.toContain(".evil")
    expect(styleText).toContain(DEFAULT_THEME.primaryColor)
  })
})

describe("keyboard use", () => {
  it("returns focus to the launcher when the panel closes", () => {
    const { shadow, launcher } = mount(async () => ({ kind: "refused" }) as never)

    launcher.click()
    // Opening moves focus into the conversation, which is what someone wants next.
    expect(shadow.activeElement?.tagName).toBe("TEXTAREA")

    shadow.querySelector<HTMLElement>('[aria-label="Close chat"]')!.click()
    // Closing must give it back. Otherwise focus falls to the document body and a keyboard user
    // is returned to the top of a stranger's website, having lost their place.
    expect(shadow.activeElement).toBe(launcher)
  })
})

describe("the opening screen", () => {
  it("greets a visitor even when the business wrote no greeting", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    // A tenant that has not opened the theme editor — the ordinary case on day one, and what
    // every screenshot of this widget showed: a grey rectangle with nothing in it.
    mountWidget(container, cfg, { sendMessage: (async () => ({ kind: "refused" })) as never })
    const shadow = container.shadowRoot!

    const greeting = shadow.querySelector(".opener-greeting")!
    expect(greeting.textContent).toMatch(/answer from its own documents/i)
  })

  it("uses the business's own greeting when there is one", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    mountWidget(
      container,
      cfg,
      { sendMessage: (async () => ({ kind: "refused" })) as never },
      sanitizeTheme({ greeting: "Halo! Ada yang bisa kami bantu?" }),
    )
    const shadow = container.shadowRoot!
    expect(shadow.querySelector(".opener-greeting")!.textContent).toBe(
      "Halo! Ada yang bisa kami bantu?",
    )
  })
})

describe("a send that failed", () => {
  it("offers to resend the same question, and asks it once", async () => {
    let calls = 0
    const sent: string[] = []
    const { send, messageList, shadow } = mount((async (_cfg: never, body: never) => {
      calls++
      sent.push((body as unknown as { message: string }).message)
      if (calls === 1) throw new Error("The assistant is temporarily unavailable.")
      return {
        kind: "answered",
        conversationId: "c1",
        segments: [{ text: "Garansi satu tahun.", kind: "business_claim", citations: [] }],
        citations: [],
        usage: ZERO_USAGE,
      }
    }) as never)

    await send("Berapa lama garansinya?")
    await Promise.resolve()
    await Promise.resolve()

    const retry = shadow.querySelector<HTMLButtonElement>(".retry")
    // Without this the visitor retypes a question the widget still has in hand, on the connection
    // that just dropped it.
    expect(retry).not.toBeNull()

    retry!.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(sent).toEqual(["Berapa lama garansinya?", "Berapa lama garansinya?"])
    expect(messageList.textContent).toContain("Garansi satu tahun.")
    // The error goes with the retry, and the question is not echoed a second time: a recovered
    // send must not read as though the customer asked twice.
    expect(shadow.querySelector(".message.error")).toBeNull()
    expect(messageList.querySelectorAll(".message.visitor")).toHaveLength(1)
  })
})
