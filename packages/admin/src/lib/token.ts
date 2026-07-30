/**
 * Admin token storage.
 *
 * The token authenticates every request to the QuidChat admin API, so it must
 * never touch `localStorage`: that survives until a user explicitly clears
 * site data and is readable by any script that ever runs on the origin. We
 * keep it in a module-level variable (fastest, gone on tab close) and mirror
 * it into `sessionStorage` only so a page reload within the same tab does not
 * force re-entering it. Closing the tab discards it, which is the point.
 */

const STORAGE_KEY = "quidchat-admin-token"

let currentToken: string | null = readFromSessionStorage()

type Listener = () => void
const listeners = new Set<Listener>()

function readFromSessionStorage(): string | null {
  if (typeof sessionStorage === "undefined") return null
  return sessionStorage.getItem(STORAGE_KEY)
}

export function getToken(): string | null {
  return currentToken
}

export function setToken(token: string): void {
  currentToken = token
  sessionStorage.setItem(STORAGE_KEY, token)
  for (const listener of listeners) listener()
}

export function clearToken(): void {
  currentToken = null
  sessionStorage.removeItem(STORAGE_KEY)
  for (const listener of listeners) listener()
}

export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
