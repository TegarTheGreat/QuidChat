import type { WidgetConfig } from "./config.js"

/**
 * Remembers which conversation this visitor is in, across page loads.
 *
 * The widget held the conversation id in a variable, so a customer who moved from the product
 * page to the checkout page started a new conversation — and the assistant lost the history it
 * answers follow-ups from. "How much is that one?" only means something after "do you have it in
 * blue?", and on a multi-page site that is exactly where the thread was being dropped.
 *
 * `sessionStorage`, not `localStorage`: a support conversation belongs to a visit. Closing the
 * tab ends it, which is both the behaviour a person expects and the one that leaves the least
 * behind on someone else's machine.
 *
 * Only the id is kept, never the messages. Restoring the visible transcript would mean an
 * endpoint that hands a conversation to anyone holding its id, which turns that id into a
 * password for someone else's questions. The server still has the history for grounding; the
 * panel simply starts empty, which is what reopening a chat widget looks like anyway.
 */

const PREFIX = "quidchat-conversation"

/** Keyed per tenant, so two assistants on one page cannot inherit each other's thread. */
function keyFor(cfg: WidgetConfig): string {
  return `${PREFIX}:${cfg.tenantSlug}`
}

/**
 * Every access is guarded. `sessionStorage` throws rather than returning null in a sandboxed
 * iframe and when a browser is set to block site data — and a widget that fails to mount because
 * it could not remember something optional would be trading an answer for a convenience.
 */
export function readConversationId(cfg: WidgetConfig): string | undefined {
  try {
    return sessionStorage.getItem(keyFor(cfg)) ?? undefined
  } catch {
    return undefined
  }
}

export function rememberConversationId(cfg: WidgetConfig, conversationId: string): void {
  try {
    sessionStorage.setItem(keyFor(cfg), conversationId)
  } catch {
    // Nothing to do and nothing worth saying: the conversation continues, it just will not
    // survive the next page load.
  }
}
