import { useSyncExternalStore } from "react"
import { getTenant, subscribeTenant } from "../lib/tenant"

/** Re-renders the caller whenever the selected tenant changes, and survives
 *  a remount because the underlying value lives in `localStorage`. */
export function useTenant(): string | null {
  return useSyncExternalStore(subscribeTenant, getTenant, () => null)
}
