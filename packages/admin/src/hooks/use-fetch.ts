import { useEffect, useState } from "react"

export type FetchState<T> =
  | { status: "pending" }
  | { status: "success"; data: T }
  | { status: "error"; message: string }

/** Loads data for the current render, re-running whenever `deps` change
 *  (typically the selected tenant). No optimistic state: callers see
 *  "pending" until the server actually answers. */
export function useFetch<T>(fn: () => Promise<T>, deps: readonly unknown[]): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ status: "pending" })

  useEffect(() => {
    let cancelled = false
    setState({ status: "pending" })
    fn()
      .then((data) => {
        if (!cancelled) setState({ status: "success", data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
    // `deps` is caller-provided on purpose: this hook re-fetches whenever the
    // caller says its inputs (usually the selected tenant) changed.
  }, deps)

  return state
}
