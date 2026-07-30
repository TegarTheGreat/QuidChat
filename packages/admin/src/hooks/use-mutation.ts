import { useCallback, useState } from "react"

export type MutationState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success" }
  | { status: "error"; message: string }

/** Wraps a write call to the admin API. Deliberately not optimistic: the
 *  caller stays in "pending" until the server responds, and only "success"
 *  once the server has actually agreed — a settings page that claims success
 *  before that would silently lose configuration. */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
) {
  const [state, setState] = useState<MutationState>({ status: "idle" })

  const mutate = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      setState({ status: "pending" })
      try {
        const result = await fn(...args)
        setState({ status: "success" })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setState({ status: "error", message })
        throw error
      }
    },
    [fn],
  )

  const reset = useCallback(() => setState({ status: "idle" }), [])

  return { state, mutate, reset }
}
