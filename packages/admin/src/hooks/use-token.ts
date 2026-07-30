import { useSyncExternalStore } from "react"
import { getToken, subscribeToken } from "../lib/token"

/** Re-renders the caller whenever the in-memory admin token changes. */
export function useToken(): string | null {
  return useSyncExternalStore(subscribeToken, getToken, () => null)
}
