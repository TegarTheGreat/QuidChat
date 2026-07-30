/**
 * The causes of a provider failure, kept separate because their CONSEQUENCES differ.
 *
 * This isn't a taxonomy for tidiness. The `EscalationReason` recorded to the
 * `escalations` table is a business signal: a business owner reads it to decide what
 * content needs writing. If 429 and 503 are recorded as `schema_invalid`, they'll
 * rewrite a knowledge base that was never the problem.
 */
export type ProviderErrorKind =
  /** The model replied with something that can't be mapped to an `Answer`. This is the
   *  ONLY cause that deserves to be `schema_invalid`. */
  | "schema"
  /** 429, or quota exhausted. The service is up, we're the one being throttled. */
  | "rate_limit"
  /** 5xx, network down, timeout. The service itself is the problem. */
  | "unavailable"
  /** 401/403, wrong key or no access to that model. Misconfiguration. */
  | "auth"
  /** The requested model is unknown to this provider. Misconfiguration. */
  | "unknown_model"

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { status?: number; cause?: unknown } = {},
  ) {
    super(message)
    this.name = "ProviderError"
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** True if retrying with the same request makes sense. */
  get isRetryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable"
  }
}
