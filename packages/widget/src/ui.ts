import { readConversationId, rememberConversationId } from "./session.js"
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
const COPY = {
  en: {
    launcherLabel: "Ask a question",
    launcherAria: "Open chat assistant",
    status: "Answers from this business's own documents",
    closeLabel: "Close chat",
    inputLabel: "Message",
    inputPlaceholder: "Ask about products, delivery, warranty…",
    sendLabel: "Send message",
    typing: "Assistant is typing…",
    // Named after what is happening rather than "Loading…". A visitor who reads "looking through
    // our documents" understands both why it takes a moment and what kind of answer is coming.
    retrieving: "Looking through our documents…",
    generating: "Writing an answer…",
    validating: "Checking it against our documents…",
    sourcePrefix: "From",
  },
  id: {
    launcherLabel: "Ada pertanyaan?",
    launcherAria: "Buka asisten chat",
    status: "Menjawab dari dokumen resmi toko",
    closeLabel: "Tutup chat",
    inputLabel: "Pesan",
    inputPlaceholder: "Tanya soal produk, pengiriman, garansi…",
    sendLabel: "Kirim pesan",
    typing: "Asisten sedang mengetik…",
    retrieving: "Mencari di dokumen kami…",
    generating: "Menyusun jawaban…",
    validating: "Mencocokkan dengan dokumen…",
    sourcePrefix: "Dari",
  },
}

/**
 * The chrome a business does not write: button labels, the placeholder, the progress lines.
 *
 * English chrome around an Indonesian answer is its own kind of broken — the customer is being
 * addressed in two languages by one assistant. The greeting and the refusal already come from the
 * server per tenant; this is the rest, and it follows the same tenant setting.
 */
type Copy = (typeof COPY)["en"]

function copyFor(locale: string): Copy {
  return locale === "id" ? COPY.id : COPY.en
}

/** A document with a turned corner — the mark on every source chip. Inline SVG because a widget
 *  cannot rely on an icon font being present on somebody else's page. */
const DOC_MARK =
  '<svg class="citation-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5l-3-3Z" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<path d="M9.5 1.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'

const CHAT_MARK =
  '<svg class="launcher-mark" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
  '<path d="M17 9.5c0 3.6-3.1 6.5-7 6.5-.9 0-1.8-.2-2.6-.4L3 17l1.2-3.1A6.2 6.2 0 0 1 3 9.5C3 5.9 6.1 3 10 3s7 2.9 7 6.5Z" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'

const SEND_MARK =
  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
  '<path d="M3 10 17 3l-4.5 14L10 11.5 3 10Z" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linejoin="round"/></svg>'

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
  const other = side === "right" ? "left" : "right"
  return `
  /*
   * No web font is loaded. This bundle runs on somebody else's website, and pulling a typeface in
   * would cost their page a render-blocking request and a layout shift for the sake of our
   * branding. The personality here comes from the scale, weight and tracking of a system stack.
   */
  :host {
    all: initial;
    --qc-ink: #16191d;
    --qc-muted: #656d79;
    --qc-line: #e6e8ec;
    --qc-surface: #ffffff;
    --qc-canvas: #f6f7f9;
    --qc-accent: ${theme.primaryColor};
    /*
     * The provenance colour is deliberately NOT the tenant's accent. A citation is QuidChat's
     * guarantee that the sentence came from the business's own document — it is not the shop's
     * decoration, and colouring it with the shop's brand would read as decoration.
     */
    --qc-cite: #0f6f5c;
    --qc-cite-bg: #eef6f3;
    --qc-radius: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    color: var(--qc-ink);
    -webkit-font-smoothing: antialiased;
  }
  * { box-sizing: border-box; }
  button { font: inherit; }
  :focus-visible { outline: 2px solid var(--qc-accent); outline-offset: 2px; }

  /* A bare emoji in a circle is what every widget does, and it tells a first-time visitor
     nothing. The pill says what it is; it collapses to a disc only where there is no room. */
  .launcher {
    position: fixed;
    ${side}: 20px;
    bottom: 20px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    height: 52px;
    padding: 0 20px 0 17px;
    border: none;
    border-radius: 26px;
    background: var(--qc-accent);
    color: #fff;
    font-size: 15px;
    font-weight: 550;
    letter-spacing: -0.005em;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(16, 20, 28, 0.18), 0 8px 24px -6px rgba(16, 20, 28, 0.32);
    transition: transform 140ms ease, box-shadow 140ms ease;
  }
  .launcher:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(16,20,28,.2), 0 14px 32px -8px rgba(16,20,28,.38); }
  .launcher:active { transform: translateY(0); }
  .launcher-mark { width: 19px; height: 19px; flex: none; }
  .launcher[aria-expanded="true"] { opacity: 0; pointer-events: none; }

  .panel {
    position: fixed;
    ${side}: 20px;
    bottom: 20px;
    width: 384px;
    max-width: calc(100vw - 40px);
    height: 588px;
    max-height: calc(100vh - 40px);
    display: flex;
    flex-direction: column;
    background: var(--qc-surface);
    border: 1px solid var(--qc-line);
    border-radius: var(--qc-radius);
    box-shadow: 0 2px 6px rgba(16, 20, 28, 0.06), 0 24px 56px -12px rgba(16, 20, 28, 0.28);
    overflow: hidden;
    animation: qc-rise 180ms cubic-bezier(0.16, 0.9, 0.3, 1) both;
  }
  .panel[hidden] { display: none; }
  @keyframes qc-rise { from { opacity: 0; transform: translateY(10px) scale(0.985); } }

  /* On a phone a 384px box floating in a 390px screen is cramped to read and to type in, while
     most of the display goes unused. Below this width it takes the screen like a messaging app. */
  @media (max-width: 480px) {
    .panel {
      inset: 0;
      width: auto; max-width: none; height: auto; max-height: none;
      border: none; border-radius: 0;
    }
    .message { max-width: 92%; }
  }

  .header {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 14px 14px 14px 18px;
    border-bottom: 1px solid var(--qc-line);
    background: var(--qc-surface);
  }
  .header-title { font-size: 15px; font-weight: 600; letter-spacing: -0.012em; }
  /* Sits under the title rather than in it: a visitor wants to know someone will answer before
     they have decided whether to type. */
  .header-status {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--qc-muted); margin-top: 1px;
  }
  .header-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--qc-cite); flex: none; }
  .header-text { min-width: 0; flex: 1; }
  .close {
    flex: none;
    width: 32px; height: 32px;
    display: grid; place-items: center;
    background: transparent;
    border: none; border-radius: 8px;
    color: var(--qc-muted);
    font-size: 20px; line-height: 1;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .close:hover { background: var(--qc-canvas); color: var(--qc-ink); }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--qc-canvas);
    scrollbar-width: thin;
  }
  .message {
    max-width: 86%;
    padding: 11px 14px;
    font-size: 14.5px;
    line-height: 1.55;
    animation: qc-in 160ms cubic-bezier(0.16, 0.9, 0.3, 1) both;
  }
  @keyframes qc-in { from { opacity: 0; transform: translateY(5px); } }
  .message p { margin: 0 0 7px 0; white-space: pre-wrap; }
  .message p:last-child { margin-bottom: 0; }
  /* Asymmetric corners: the flattened corner points at its author, which is what tells you at a
     glance who is speaking without needing colour to carry it alone. */
  .message.visitor {
    align-self: flex-end;
    background: var(--qc-accent);
    color: #fff;
    border-radius: 14px 14px 4px 14px;
  }
  .message.assistant {
    align-self: flex-start;
    background: var(--qc-surface);
    border: 1px solid var(--qc-line);
    border-radius: 14px 14px 14px 4px;
    box-shadow: 0 1px 2px rgba(16, 20, 28, 0.04);
  }
  .message.error {
    align-self: flex-start;
    background: #fdf2f2;
    border: 1px solid #f6d5d5;
    color: #8c1d1d;
    border-radius: 14px;
  }

  /*
   * The source chip — the one thing here that no other chat widget can show, and the reason this
   * product exists. It used to be twelve grey pixels at 70% opacity, which said "footnote". Every
   * business claim traces to a document the owner uploaded, and that is the whole promise, so it
   * is built to be read.
   */
  .citation {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 9px;
    padding: 4px 10px 4px 8px;
    background: var(--qc-cite-bg);
    color: var(--qc-cite);
    border-radius: 7px;
    font-size: 11.5px;
    font-weight: 550;
    letter-spacing: 0.005em;
    max-width: 100%;
  }
  .citation-mark { width: 12px; height: 12px; flex: none; }
  .citation-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .typing { display: inline-flex; align-items: center; gap: 9px; }
  .typing-dots { display: inline-flex; gap: 3px; }
  .typing-dots i {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--qc-muted);
    animation: qc-pulse 1.15s ease-in-out infinite;
  }
  .typing-dots i:nth-child(2) { animation-delay: 0.15s; }
  .typing-dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes qc-pulse { 0%, 60%, 100% { opacity: 0.28; } 30% { opacity: 1; } }
  .typing-text { font-size: 12.5px; color: var(--qc-muted); }

  .composer {
    display: flex;
    align-items: flex-end;
    gap: 9px;
    padding: 12px 14px 14px;
    border-top: 1px solid var(--qc-line);
    background: var(--qc-surface);
  }
  textarea {
    flex: 1;
    resize: none;
    font-family: inherit;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--qc-ink);
    padding: 10px 12px;
    border: 1px solid var(--qc-line);
    border-radius: 11px;
    background: var(--qc-canvas);
    max-height: 108px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  textarea:focus { outline: none; border-color: var(--qc-accent); background: var(--qc-surface); }
  textarea::placeholder { color: var(--qc-muted); }
  .send {
    flex: none;
    width: 40px; height: 40px;
    display: grid; place-items: center;
    border: none; border-radius: 11px;
    background: var(--qc-accent);
    color: #fff;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .send svg { width: 17px; height: 17px; }
  .send:hover:not(:disabled) { transform: translateY(-1px); }
  .send:disabled { opacity: 0.4; cursor: default; }

  .footer {
    padding: 0 14px 11px;
    font-size: 11px;
    color: var(--qc-muted);
    text-align: ${other === "left" ? "right" : "left"};
    background: var(--qc-surface);
  }

  @media (prefers-reduced-motion: reduce) {
    .panel, .message { animation: none; }
    .typing-dots i { animation: none; opacity: 0.6; }
    .launcher, .send, .close, textarea { transition: none; }
  }
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
  copy: Copy,
): void {
  const doc = bubble.ownerDocument
  const p = doc.createElement("p")
  p.textContent = segment.text
  bubble.appendChild(p)

  if (segment.kind === "business_claim") {
    // Document titles, not chunk ids. The whole point of showing a source is that the visitor
    // recognises it — a UUID satisfies the shape of "you can see where this came from" without
    // telling them anything. Duplicates collapse: two chunks of one document are one source.
    const titles = [
      ...new Set(segment.citations.map((chunkId) => citationTitles.get(chunkId) ?? chunkId)),
    ]
    const cite = doc.createElement("span")
    cite.className = "citation"
    cite.innerHTML = DOC_MARK
    const label = doc.createElement("span")
    label.className = "citation-text"
    label.textContent = `${copy.sourcePrefix} ${titles.join(", ")}`
    cite.appendChild(label)
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

  const copy = copyFor(theme.locale)

  const launcher = doc.createElement("button")
  launcher.className = "launcher"
  launcher.setAttribute("aria-label", copy.launcherAria)
  launcher.setAttribute("aria-haspopup", "dialog")
  launcher.setAttribute("aria-expanded", "false")
  launcher.innerHTML = CHAT_MARK
  const launcherText = doc.createElement("span")
  launcherText.textContent = copy.launcherLabel
  launcher.appendChild(launcherText)

  const panel = doc.createElement("div")
  panel.className = "panel"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-label", theme.title)
  panel.hidden = true

  const header = doc.createElement("div")
  header.className = "header"
  const headerText = doc.createElement("div")
  headerText.className = "header-text"
  const title = doc.createElement("div")
  title.className = "header-title"
  title.textContent = theme.title
  // A visitor decides whether to type before they have asked anything. Saying where the answers
  // come from is what makes the difference between this and a bot that will guess at them.
  const status = doc.createElement("div")
  status.className = "header-status"
  const dot = doc.createElement("span")
  dot.className = "header-dot"
  const statusText = doc.createElement("span")
  statusText.textContent = copy.status
  status.append(dot, statusText)
  headerText.append(title, status)
  const closeButton = doc.createElement("button")
  closeButton.className = "close"
  closeButton.setAttribute("aria-label", copy.closeLabel)
  closeButton.textContent = "×"
  header.append(headerText, closeButton)

  const messages = doc.createElement("div")
  messages.className = "messages"
  messages.setAttribute("role", "log")
  messages.setAttribute("aria-live", "polite")

  const composer = doc.createElement("form")
  composer.className = "composer"
  const input = doc.createElement("textarea")
  input.setAttribute("aria-label", copy.inputLabel)
  // The server refuses anything longer, and the browser stopping it at the keyboard is better
  // than a round trip that comes back as an error. Kept in step with MAX_MESSAGE_LENGTH there.
  input.setAttribute("maxlength", "4000")
  input.setAttribute("placeholder", copy.inputPlaceholder)
  input.rows = 1
  const sendButton = doc.createElement("button")
  sendButton.className = "send"
  sendButton.type = "submit"
  sendButton.setAttribute("aria-label", copy.sendLabel)
  sendButton.innerHTML = SEND_MARK
  composer.append(input, sendButton)

  panel.append(header, messages, composer)
  shadow.append(launcher, panel)

  // Picked up from the visitor's tab, so moving between pages continues the conversation rather
  // than starting one the assistant has no history for.
  let conversationId: string | undefined = readConversationId(config)
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
    // Focus goes back to the button that opened it. Without this, closing with Escape drops
    // focus to the document body, and a keyboard user is returned to the top of a stranger's
    // website having lost their place entirely.
    launcher.focus()
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
      appendSegment(bubble, segment, citationTitles, copy)
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
    const label = typingIndicator?.querySelector(".typing-text")
    if (!label) return
    label.textContent =
      stage === "retrieving" ? copy.retrieving
      : stage === "generating" ? copy.generating
      : copy.validating
    messages.scrollTop = messages.scrollHeight
  }

  function setPending(next: boolean): void {
    pending = next
    sendButton.disabled = next
    if (next) {
      // Its own element, not the citation class it used to borrow: a citation is now a green
      // provenance chip, and "the assistant is typing" is not a source.
      typingIndicator = doc.createElement("div")
      typingIndicator.className = "message assistant typing"
      typingIndicator.innerHTML =
        '<span class="typing-dots"><i></i><i></i><i></i></span>'
      const typingText = doc.createElement("span")
      typingText.className = "typing-text"
      typingText.textContent = copy.typing
      typingIndicator.appendChild(typingText)
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
      rememberConversationId(config, result.conversationId)
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
