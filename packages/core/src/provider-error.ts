/**
 * Sebab kegagalan sebuah provider, dipisahkan karena AKIBATNYA berbeda.
 *
 * Ini bukan taksonomi demi kerapian. `EscalationReason` yang dicatat ke tabel
 * `escalations` adalah sinyal bisnis: pemilik bisnis membacanya untuk memutuskan konten
 * apa yang perlu ditulis. Kalau 429 dan 503 dicatat sebagai `schema_invalid`, ia akan
 * menulis ulang basis pengetahuan yang sejak awal bukan masalahnya.
 */
export type ProviderErrorKind =
  /** Model membalas sesuatu yang tidak bisa dipetakan ke `Answer`. Ini SATU-SATUNYA
   *  yang layak jadi `schema_invalid`. */
  | "schema"
  /** 429, atau kuota habis. Layanannya hidup, kita yang dibatasi. */
  | "rate_limit"
  /** 5xx, jaringan mati, timeout. Layanannya yang bermasalah. */
  | "unavailable"
  /** 401/403, kunci salah atau tidak punya akses ke model itu. Salah konfigurasi. */
  | "auth"
  /** Model yang diminta tidak dikenal provider ini. Salah konfigurasi. */
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

  /** True bila mencoba lagi dengan permintaan yang sama masuk akal. */
  get dapatDiulang(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable"
  }
}
