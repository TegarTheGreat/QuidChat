// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { ChatResponse } from "./api.js"
import type { WidgetConfig } from "./config.js"
import { mountWidget } from "./ui.js"

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
      citedChunkIds: ["chunk-42"],
    }))

    launcher.click()
    await send("How long is the warranty?")
    await vi.waitFor(() => {
      expect(messageList.textContent).toContain("The warranty lasts 12 months.")
      expect(messageList.textContent).toContain("chunk-42")
    })
  })

  it("renders no source for a general segment", async () => {
    const { launcher, messageList, send } = mount(async () => ({
      conversationId: "c1",
      kind: "answered",
      segments: [{ kind: "general", text: "Sure, happy to help!" }],
      citedChunkIds: [],
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

    resolve({ conversationId: "c1", kind: "answered", segments: [], citedChunkIds: [] })
    await vi.waitFor(() => {
      expect(sendButton.disabled).toBe(false)
    })
  })

  it("sends on Enter, but inserts a newline instead of sending on Shift+Enter", async () => {
    const sendMessage = vi.fn(async (): Promise<ChatResponse> => ({
      conversationId: "c1",
      kind: "answered",
      segments: [],
      citedChunkIds: [],
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
      citedChunkIds: [],
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
      citedChunkIds: [],
    }))

    launcher.click()
    expect(shadow.activeElement).toBe(input)
  })
})
