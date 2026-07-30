import { describe, expect, it } from "vitest"
import {
  decryptSecrets,
  encryptSecrets,
  hasSecretKey,
  readSecretKey,
  SecretDecryptError,
  SecretKeyError,
} from "./secrets.js"

const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64")

describe("readSecretKey", () => {
  it("accepts base64 and hex, since both come out of openssl rand", () => {
    expect(readSecretKey({ QUIDCHAT_SECRET_KEY: KEY_BASE64 })).toHaveLength(32)
    expect(readSecretKey({ QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 9).toString("hex") })).toHaveLength(32)
  })

  it("refuses to invent a key when none is configured", () => {
    // Falling back to plaintext or to a key derived from something convenient would look like
    // the feature working while removing the protection it exists to provide.
    for (const env of [{}, { QUIDCHAT_SECRET_KEY: "" }, { QUIDCHAT_SECRET_KEY: "   " }]) {
      expect(() => readSecretKey(env)).toThrow(SecretKeyError)
    }
    expect(hasSecretKey({})).toBe(false)
    expect(hasSecretKey({ QUIDCHAT_SECRET_KEY: KEY_BASE64 })).toBe(true)
  })

  it("names the actual length when the key is the wrong size", () => {
    // The usual mistake is a truncated line or a 16-byte key, and the fix is obvious once the
    // length is stated.
    expect(() => readSecretKey({ QUIDCHAT_SECRET_KEY: Buffer.alloc(16, 1).toString("base64") })).toThrow(
      /must decode to 32 bytes, got 16/,
    )
  })
})

describe("encryptSecrets and decryptSecrets", () => {
  const key = readSecretKey({ QUIDCHAT_SECRET_KEY: KEY_BASE64 })

  it("round-trips a credential object", () => {
    const secrets = { botToken: "123:ABC", secretToken: "hook-secret" }
    const stored = encryptSecrets(secrets, key)
    expect(stored.startsWith("v1.")).toBe(true)
    // The plaintext must not be recoverable by reading the row.
    expect(stored).not.toContain("123:ABC")
    expect(decryptSecrets(stored, key)).toEqual(secrets)
  })

  it("never produces the same ciphertext twice for the same input", () => {
    // A reused IV under one key breaks GCM's authentication outright, not just its secrecy.
    const a = encryptSecrets({ botToken: "same" }, key)
    const b = encryptSecrets({ botToken: "same" }, key)
    expect(a).not.toBe(b)
    expect(decryptSecrets(a, key)).toEqual(decryptSecrets(b, key))
  })

  it("rejects a row that has been altered, rather than decrypting it to something else", () => {
    const stored = encryptSecrets({ botToken: "real-token" }, key)
    const [version, iv, tag, ciphertext] = stored.split(".")
    const flipped = Buffer.from(ciphertext!, "base64url")
    flipped[0] = flipped[0]! ^ 0xff
    const tampered = [version, iv, tag, flipped.toString("base64url")].join(".")

    // This is why GCM rather than CBC: someone with write access to the table must not be able
    // to swap in credentials of their choosing.
    expect(() => decryptSecrets(tampered, key)).toThrow(SecretDecryptError)
  })

  it("rejects the wrong key, a truncated row, and an unknown version", () => {
    const stored = encryptSecrets({ botToken: "real-token" }, key)
    const otherKey = readSecretKey({ QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 8).toString("base64") })

    expect(() => decryptSecrets(stored, otherKey)).toThrow(/QUIDCHAT_SECRET_KEY has most likely changed/)
    expect(() => decryptSecrets("v1.short", key)).toThrow(/not in a format this version can read/)
    expect(() => decryptSecrets(stored.replace("v1.", "v2."), key)).toThrow(
      /not in a format this version can read/,
    )
  })

  it("names what could not be read without leaking any of it", () => {
    const stored = encryptSecrets({ botToken: "real-token" }, key)
    const otherKey = readSecretKey({ QUIDCHAT_SECRET_KEY: Buffer.alloc(32, 8).toString("base64") })
    try {
      decryptSecrets(stored, otherKey, "telegram credentials")
      expect.unreachable()
    } catch (e) {
      const message = (e as Error).message
      expect(message).toContain("telegram credentials")
      // Neither the ciphertext nor any key material belongs in a log line.
      expect(message).not.toContain(stored.split(".")[3]!)
      expect(message).not.toContain(KEY_BASE64)
    }
  })
})
