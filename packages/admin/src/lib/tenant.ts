/**
 * Selected-tenant storage.
 *
 * Unlike the admin token, this belongs in `localStorage` on purpose: losing
 * the selected tenant on every refresh would make every other screen (usage,
 * knowledge, conversations, settings) show the wrong tenant's data, or none
 * at all, until the operator picks it again.
 */

const STORAGE_KEY = "quidchat-admin-tenant"

let currentTenant: string | null = readFromLocalStorage()

type Listener = () => void
const listeners = new Set<Listener>()

function readFromLocalStorage(): string | null {
  if (typeof localStorage === "undefined") return null
  return localStorage.getItem(STORAGE_KEY)
}

export function getTenant(): string | null {
  return currentTenant
}

export function setTenant(slug: string): void {
  currentTenant = slug
  localStorage.setItem(STORAGE_KEY, slug)
  for (const listener of listeners) listener()
}

export function clearTenant(): void {
  currentTenant = null
  localStorage.removeItem(STORAGE_KEY)
  for (const listener of listeners) listener()
}

export function subscribeTenant(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
