// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { ChatResponse } from "./api.js"
import type { WidgetConfig } from "./config.js"
import { DEFAULT_THEME, sanitizeTheme } from "./theme.js"
import { mountWidget } from "./ui.js"

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

    const styleText = container.shadowRoot!.querySelector("style")!.textContent!
    expect(styleText).not.toContain(".evil")
    expect(styleText).toContain(DEFAULT_THEME.primaryColor)
  })
})
