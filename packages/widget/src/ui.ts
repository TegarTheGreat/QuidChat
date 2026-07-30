import {
  sendMessageWithProgress as defaultSendMessage,
  type ChatResponse,
  type ProgressStage,
  type Segment,
} from "./api.js"
import type { WidgetConfig } from "./config.js"
import { DEFAULT_THEME, type WidgetTheme } from "./theme.js"

export type UiDeps = {
  sendMessage: typeof defaultSendMessage
}

const DEFAULT_DEPS: UiDeps = { sendMessage: defaultSendMessage }

/*
 * Every user-facing string below is hardcoded English — the launcher label, the
 * placeholder, the close/send labels. None of it is the greeting or the refusal
 * (those come from the server, per tenant); it is UI chrome that stays the same for
 * every tenant. The one exception is the dialog title, which is no longer here: it
 * comes from `theme.title` (see `theme.ts` and `mountWidget`'s `theme` parameter)
 * because that field of `tenant_settings.widget_theme` is exactly the kind of thing
 * a business reasonably wants to change — everything else below is not.
 */
const STRINGS = {
  launcherLabel: "Open chat assistant",
  closeLabel: "Close chat",
  inputLabel: "Message",
  inputPlaceholder: "Type your message…",
  sendLabel: "Send message",
  typing: "Assistant is typing…",
  // Named after what is happening rather than "Loading…". A visitor who reads "looking through
  // our documents" understands both why it takes a moment and what kind of answer is coming.
  retrieving: "Looking through our documents…",
  generating: "Writing an answer…",
  validating: "Checking it against our documents…",
}

/**
 * `theme.primaryColor` and `theme.position` are the only two values interpolated
 * into this CSS text. Both are safe to interpolate directly because `sanitizeTheme`
 * (see `theme.ts`) already constrains them to a strict pattern before this function
 * ever sees them — `primaryColor` to hex/rgb()/a fixed name, `position` to the
 * literal `"left"` or `"right"` — so neither can contain a `;`, a `}`, or anything
 * else that could close this declaration and inject further rules.
 */
function buildStyle(theme: WidgetTheme): string {
  const side = theme.position
  return `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  .launcher {
    position: fixed;
    ${side}: 20px;
    bottom: 20px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    background: ${theme.primaryColor};
    color: #fff;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  }
  .panel {
    position: fixed;
    ${side}: 20px;
    bottom: 88px;
    width: 320px;
    max-width: calc(100vw - 40px);
    height: 440px;
    max-height: calc(100vh - 120px);
    display: flex;
    flex-direction: column;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }
  .panel[hidden] { display: none; }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: ${theme.primaryColor};
    color: #fff;
  }
  .header-title { font-weight: 600; font-size: 14px; }
  .close {
    background: transparent;
    border: none;
    color: #fff;
    font-size: 18px;
    cursor: pointer;
    line-height: 1;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .message {
    max-width: 85%;
    padding: 8px 12px;
    border-radius: 10px;
    font-size: 14px;
    line-height: 1.4;
    white-space: pre-wrap;
  }
  .message p { margin: 0 0 4px 0; }
  .message p:last-child { margin-bottom: 0; }
  .message.visitor { align-self: flex-end; background: ${theme.primaryColor}; color: #fff; }
  .message.assistant { align-self: flex-start; background: #f1f3f5; color: #111; }
  .message.error { align-self: flex-start; background: #fdecec; color: #92140c; }
  .citation { font-size: 12px; opacity: 0.7; }
  .composer {
    display: flex;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid #e5e7eb;
  }
  textarea {
    flex: 1;
    resize: none;
    font-family: inherit;
    font-size: 14px;
    padding: 8px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    max-height: 80px;
  }
  .send {
    border: none;
    border-radius: 8px;
    background: ${theme.primaryColor};
    color: #fff;
    padding: 0 14px;
    cursor: pointer;
    font-size: 14px;
  }
  .send:disabled { opacity: 0.5; cursor: default; }
`
}

/** Appends one `business_claim` or `general` segment as a paragraph inside `bubble`.
 *  A `business_claim` also gets a visible citation line right below it — never a
 *  hover or a tooltip, since the whole point is that a visitor can see, without
 *  interacting with anything, that the claim traces back to a real document. A
 *  `general` segment gets none, because it isn't a claim about the business. */
function appendSegment(
  bubble: HTMLElement,
  segment: Segment,
  citationTitles: Map<string, string>,
): void {
  const doc = bubble.ownerDocument
  const p = doc.createElement("p")
  p.textContent = segment.text
  bubble.appendChild(p)

  if (segment.kind === "business_claim") {
    const cite = doc.createElement("p")
    cite.className = "citation"
    // Document titles, not chunk ids. The whole point of showing a source is that the
    // visitor recognises it — a UUID satisfies the shape of "you can see where this
    // came from" without telling them anything.
    //
    // A segment carries the chunk ids it cited; the titles arrive separately on the
    // result, so they are matched up here. Duplicates are collapsed because two chunks
    // from the same document should read as one source, not the same name twice.
    const titles = [
      ...new Set(
        segment.citations.map(
          (chunkId) => citationTitles.get(chunkId) ?? chunkId,
        ),
      ),
    ]
    cite.textContent = `Source: ${titles.join(", ")}`
    bubble.appendChild(cite)
  }
}

/**
 * Mounts the widget into `container` (which the caller has already inserted into
 * the document) using a shadow root for style isolation. `deps` defaults to the
 * real API client; tests inject a fake one so the UI tests never touch `fetch`.
 *
 * `theme` defaults to `DEFAULT_THEME` — the widget's original hardcoded look — so
 * every existing caller and test that only passes `container`/`config`/`deps`
 * keeps rendering exactly as before. The caller (`index.ts`) is the one that
 * awaits `fetchWidgetTheme` and passes the resolved value in; `mountWidget` itself
 * stays synchronous and never touches the network, which is what keeps it easy to
 * unit-test with a plain fake `deps`.
 */
/**
 * Puts the widget's CSS into its shadow root.
 *
 * Prefers a constructable stylesheet over a `<style>` element, because this bundle runs on
 * somebody else's website and a strict `Content-Security-Policy` there — `style-src 'self'`,
 * common on the kind of site that has a security team — blocks an inline `<style>` outright.
 * The widget would mount completely unstyled, which looks like a broken product rather than a
 * policy doing its job. A stylesheet built through the CSSOM is not inline content and is not
 * blocked.
 *
 * The `<style>` fallback stays for browsers without `adoptedStyleSheets`, and for the happy_dom
 * environment the unit tests run in, where the constructable path does not exist.
 */
function applyStyles(shadow: ShadowRoot, doc: Document, css: string): void {
  const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null
  const SheetCtor = view?.CSSStyleSheet
  if (SheetCtor && "adoptedStyleSheets" in shadow) {
    try {
      const sheet = new SheetCtor()
      // `replaceSync` is what makes this synchronous, so nothing renders before it is styled.
      sheet.replaceSync(css)
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]
      return
    } catch {
      // Some engines expose the constructor but not construction from another realm. Falling
      // through costs nothing and is still correct anywhere CSP is not enforcing.
    }
  }
  const style = doc.createElement("style")
  style.textContent = css
  shadow.appendChild(style)
}

export function mountWidget(
  container: HTMLElement,
  config: WidgetConfig,
  deps: UiDeps = DEFAULT_DEPS,
  theme: WidgetTheme = DEFAULT_THEME,
): void {
  const doc = container.ownerDocument
  const shadow = container.attachShadow({ mode: "open" })

  applyStyles(shadow, doc, buildStyle(theme))

  const launcher = doc.createElement("button")
  launcher.className = "launcher"
  launcher.setAttribute("aria-label", STRINGS.launcherLabel)
  launcher.setAttribute("aria-haspopup", "dialog")
  launcher.setAttribute("aria-expanded", "false")
  launcher.textContent = "💬"

  const panel = doc.createElement("div")
  panel.className = "panel"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-label", theme.title)
  panel.hidden = true

  const header = doc.createElement("div")
  header.className = "header"
  const title = doc.createElement("span")
  title.className = "header-title"
  title.textContent = theme.title
  const closeButton = doc.createElement("button")
  closeButton.className = "close"
  closeButton.setAttribute("aria-label", STRINGS.closeLabel)
  closeButton.textContent = "×"
  header.append(title, closeButton)

  const messages = doc.createElement("div")
  messages.className = "messages"
  messages.setAttribute("role", "log")
  messages.setAttribute("aria-live", "polite")

  const composer = doc.createElement("form")
  composer.className = "composer"
  const input = doc.createElement("textarea")
  input.setAttribute("aria-label", STRINGS.inputLabel)
  input.setAttribute("placeholder", STRINGS.inputPlaceholder)
  input.rows = 1
  const sendButton = doc.createElement("button")
  sendButton.className = "send"
  sendButton.type = "submit"
  sendButton.setAttribute("aria-label", STRINGS.sendLabel)
  sendButton.textContent = "Send"
  composer.append(input, sendButton)

  panel.append(header, messages, composer)
  shadow.append(launcher, panel)

  let conversationId: string | undefined
  let pending = false
  let typingIndicator: HTMLElement | undefined

  function openPanel(): void {
    panel.hidden = false
    launcher.setAttribute("aria-expanded", "true")
    input.focus()
  }

  function closePanel(): void {
    panel.hidden = true
    launcher.setAttribute("aria-expanded", "false")
  }

  function appendBubble(role: "visitor" | "assistant" | "error"): HTMLElement {
    const bubble = doc.createElement("div")
    bubble.className = `message ${role}`
    messages.appendChild(bubble)
    messages.scrollTop = messages.scrollHeight
    return bubble
  }

  function appendVisitorMessage(text: string): void {
    const bubble = appendBubble("visitor")
    const p = doc.createElement("p")
    p.textContent = text
    bubble.appendChild(p)
  }

  function appendResult(result: ChatResponse): void {
    if (result.kind === "refused") {
      // A refusal is a successful outcome — the assistant's knowledge base had
      // nothing relevant, and saying so is the product working as designed. It
      // renders exactly like any other assistant reply, never like the `error`
      // bubble below.
      const bubble = appendBubble("assistant")
      const p = doc.createElement("p")
      p.textContent = result.text
      bubble.appendChild(p)
      return
    }

    const bubble = appendBubble("assistant")
    // Built once per answer rather than per segment: several segments commonly cite the
    // same document, and a lookup is clearer than searching the array each time.
    const citationTitles = new Map(
      result.citations.map((c) => [c.chunkId, c.documentTitle]),
    )
    for (const segment of result.segments) {
      appendSegment(bubble, segment, citationTitles)
    }
  }

  function appendErrorMessage(text: string): void {
    const bubble = appendBubble("error")
    const p = doc.createElement("p")
    p.textContent = text
    bubble.appendChild(p)
  }

  /** Replaces the indicator's text as the server reports each stage. */
  function setStage(stage: ProgressStage): void {
    if (!typingIndicator) return
    typingIndicator.textContent =
      stage === "retrieving" ? STRINGS.retrieving
      : stage === "generating" ? STRINGS.generating
      : STRINGS.validating
    messages.scrollTop = messages.scrollHeight
  }

  function setPending(next: boolean): void {
    pending = next
    sendButton.disabled = next
    if (next) {
      typingIndicator = doc.createElement("p")
      typingIndicator.className = "citation"
      typingIndicator.textContent = STRINGS.typing
      messages.appendChild(typingIndicator)
      messages.scrollTop = messages.scrollHeight
    } else if (typingIndicator) {
      typingIndicator.remove()
      typingIndicator = undefined
    }
  }

  async function submit(): Promise<void> {
    const text = input.value.trim()
    if (text === "" || pending) return

    // The visitor's own message appears before the round trip starts, not after —
    // waiting for the server to echo it back makes the widget feel broken on a
    // slow connection.
    appendVisitorMessage(text)
    input.value = ""
    setPending(true)

    try {
      const result = await deps.sendMessage(
        config,
        { message: text, ...(conversationId !== undefined ? { conversationId } : {}) },
        setStage,
      )
      conversationId = result.conversationId
      appendResult(result)
    } catch (err) {
      appendErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  launcher.addEventListener("click", () => {
    if (panel.hidden) openPanel()
    else closePanel()
  })

  closeButton.addEventListener("click", closePanel)

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel()
  })

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
    // Shift+Enter falls through with no special handling, so the browser's default
    // textarea behavior (insert a newline) applies.
  })

  composer.addEventListener("submit", (e) => {
    e.preventDefault()
    void submit()
  })
}
