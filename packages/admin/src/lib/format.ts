/**
 * Presentation helpers.
 *
 * Timestamps arrive as Postgres text — `2026-07-30 14:27:00.406+00` — and every screen was
 * printing them as-is. That is a database value shown to a shop owner: the fractional seconds
 * are noise, the space instead of a `T` is not a format anyone writes, and the offset says
 * nothing to someone who only wants to know whether this happened today.
 */

/**
 * Parses what the API sends.
 *
 * Postgres emits `2026-07-30 14:27:00.406+00`, and TWO things about that are not ISO 8601: the
 * space instead of a `T`, and a two-digit offset where the standard wants `+00:00`. JavaScript
 * rejects both, so `new Date` on the raw value returns Invalid Date — which the first version of
 * this helper handled by silently falling back to the raw string, meaning it changed nothing at
 * all while appearing to work.
 */
function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  let iso = value.includes("T") ? value : value.replace(" ", "T")
  // `+00` or `-05` at the end becomes `+00:00` / `-05:00`. A `Z`, a full offset, or no offset at
  // all are all left alone.
  iso = iso.replace(/([+-])(\d{2})$/, "$1$2:00")
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A date and time in the reader's own locale and zone, or the raw value when it cannot be
 *  parsed — showing something unexpected beats showing "Invalid Date". */
export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value)
  if (!date) return value ?? "—"
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * How long ago, in words, for anything within a week; the date itself beyond that.
 *
 * "3 hours ago" is what a person actually wants from a queue they are working through, and a
 * date is what they want once something is old enough that the exact day matters again.
 */
export function formatRelative(value: string | null | undefined): string {
  const date = parse(value)
  if (!date) return value ?? "—"
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`
  return formatDateTime(value)
}
