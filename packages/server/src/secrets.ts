import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Encryption for credentials a business enters in the panel.
 *
 * Channel credentials are not passwords to be checked — they have to be sent to WhatsApp or
 * Telegram on every reply, so they must be recoverable, which rules out hashing. That leaves
 * encryption with a key held outside the database, so that a database backup, a read replica or
 * a stray `SELECT` does not hand over the ability to send messages as the business.
 *
 * AES-256-GCM rather than AES-CBC: GCM authenticates the ciphertext, so a row an attacker with
 * write access has altered fails to decrypt instead of decrypting to something else. Without
 * that, someone able to write to the table could swap in credentials of their choosing.
 */

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
const VERSION = "v1"

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecretKeyError"
  }
}

/**
 * Reads and validates the key.
 *
 * Throws rather than falling back to storing plaintext, and rather than deriving a key from
 * something convenient like the admin token. Both would look like the feature working while
 * quietly removing the protection it exists to provide, and nobody would find out until the
 * database leaked.
 *
 * Accepts base64 or hex, because a key is something a person pastes from `openssl rand` and
 * both forms come out of it depending on the flags.
 */
export function readSecretKey(env: Record<string, string | undefined>): Buffer {
  const raw = env.QUIDCHAT_SECRET_KEY
  if (!raw || raw.trim() === "") {
    throw new SecretKeyError(
      "QUIDCHAT_SECRET_KEY is not set, and channel credentials cannot be stored without it. " +
        "Generate one with: openssl rand -base64 32",
    )
  }
  const trimmed = raw.trim()
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64")
  if (key.length !== KEY_BYTES) {
    // Named lengths rather than "invalid key": the usual mistake is pasting a 16-byte key or a
    // truncated line, and the fix is obvious once the actual length is stated.
    throw new SecretKeyError(
      `QUIDCHAT_SECRET_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
    )
  }
  return key
}

/** True when a key is configured and usable, so a caller can offer the feature or explain its
 *  absence without catching an exception to find out. */
export function hasSecretKey(env: Record<string, string | undefined>): boolean {
  try {
    readSecretKey(env)
    return true
  } catch {
    return false
  }
}

/**
 * Encrypts a JSON-serialisable value.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is there
 * so a future change of algorithm can read old rows instead of failing on them: without it,
 * rotating the scheme means every business re-entering their credentials.
 *
 * A fresh random IV per encryption is not optional with GCM — reusing one under the same key
 * breaks the authentication entirely, not just confidentiality.
 */
export function encryptSecrets(value: unknown, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), "utf8")
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecretDecryptError"
  }
}

/**
 * Decrypts a stored blob.
 *
 * Every failure — a wrong key, a truncated row, a tampered ciphertext, a version this build
 * does not know — comes back as the same error type with a message that names the row's channel
 * rather than the key or any part of the ciphertext. The most likely real cause is a key that
 * changed, and that is worth stating; the ciphertext is not worth logging.
 */
export function decryptSecrets(stored: string, key: Buffer, label = "credentials"): unknown {
  const parts = stored.split(".")
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptError(`stored ${label} are not in a format this version can read`)
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url")
    const tag = Buffer.from(parts[2]!, "base64url")
    const ciphertext = Buffer.from(parts[3]!, "base64url")
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString("utf8"))
  } catch {
    throw new SecretDecryptError(
      `stored ${label} could not be decrypted — QUIDCHAT_SECRET_KEY has most likely changed ` +
        "since they were saved, and they will need to be entered again",
    )
  }
}
