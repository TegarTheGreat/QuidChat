import { createHmac, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it } from "vitest"
import { discordAdapter } from "./discord.js"
import { telegramAdapter } from "./telegram.js"
import { wahaAdapter, whatsappCloudAdapter } from "./whatsapp.js"

/**
 * Signature verification, which had no tests at all.
 *
 * This is the only thing standing between a business's conversation history and anyone who
 * learns its webhook URL. A forged request that gets through is answered, recorded and billed —
 * and on a channel the visitor can be impersonated, so the words appear to come from a real
 * customer. Every case below is one that must fail closed.
 */

const BODY = JSON.stringify({ hello: "world" })

/** A Telegram adapter, with or without the secret Telegram echoes back on every webhook. */
function telegramWith(secretToken?: string) {
  return telegramAdapter({
    tenantSlug: "shop",
    botToken: "123:abc",
    ...(secretToken ? { secretToken } : {}),
  })
}

describe("telegram", () => {
  it("accepts the secret Telegram was given and refuses everything else", () => {
    const verify = telegramWith("s3cret").verify!
    expect(verify({ body: BODY, headers: { "x-telegram-bot-api-secret-token": "s3cret" } })).toBe(true)

    for (const headers of [
      { "x-telegram-bot-api-secret-token": "wrong" },
      // A prefix must not pass: a comparison that stopped early would let an attacker learn the
      // secret one character at a time.
      { "x-telegram-bot-api-secret-token": "s3cre" },
      { "x-telegram-bot-api-secret-token": "s3cretx" },
      { "x-telegram-bot-api-secret-token": "" },
      {},
    ]) {
      expect(verify({ body: BODY, headers }), JSON.stringify(headers)).toBe(false)
    }
  })

  it("takes the first value when a header arrives more than once", () => {
    // Node hands back an array for repeated headers, and a request can repeat them deliberately.
    const verify = telegramWith("s3cret").verify!
    expect(verify({ body: BODY, headers: { "x-telegram-bot-api-secret-token": ["s3cret"] } })).toBe(true)
    expect(verify({ body: BODY, headers: { "x-telegram-bot-api-secret-token": ["wrong", "s3cret"] } })).toBe(false)
  })

  it("verifies nothing when no secret is configured", () => {
    // Honest rather than safe, and deliberately so: the server refuses to mount a channel with no
    // credentials, so the decision belongs there where it can be reported.
    expect(telegramWith().verify!({ body: BODY, headers: {} })).toBe(true)
  })
})

const APP_SECRET = "app-secret"

/** The header Meta sends: an HMAC over the exact body, hex, behind a `sha256=` prefix. */
function signatureFor(body: string, secret = APP_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

describe("whatsapp cloud", () => {
  const adapter = whatsappCloudAdapter({
    tenantSlug: "shop",
    phoneNumberId: "555",
    accessToken: "token",
    appSecret: APP_SECRET,
  })

  it("accepts Meta's signature over the exact body", () => {
    expect(
      adapter.verify!({ body: BODY, headers: { "x-hub-signature-256": signatureFor(BODY) } }),
    ).toBe(true)
  })

  it("refuses a body that changed after it was signed", () => {
    // The whole point of signing: the bytes answered must be the bytes signed. A verifier that
    // checked a parsed object rather than the raw body would pass this.
    const tampered = JSON.stringify({ hello: "world", injected: true })
    expect(
      adapter.verify!({ body: tampered, headers: { "x-hub-signature-256": signatureFor(BODY) } }),
    ).toBe(false)
  })

  it("signs the bytes that arrived, not a tidied-up version of them", () => {
    // Meta signs the exact body it sends, whitespace and key order included. A verifier that
    // re-serialised the JSON before hashing would compute a different digest and reject
    // perfectly legitimate traffic — and nothing else in this file would notice, because every
    // other case changes the content too.
    const spaced = '{ "hello" : "world" ,\n  "b" : 1 }'
    expect(
      adapter.verify!({ body: spaced, headers: { "x-hub-signature-256": signatureFor(spaced) } }),
    ).toBe(true)
  })

  it("refuses another secret, a missing header and a malformed one", () => {
    for (const headers of [
      { "x-hub-signature-256": signatureFor(BODY, "not-the-secret") },
      { "x-hub-signature-256": createHmac("sha256", APP_SECRET).update(BODY).digest("hex") },
      { "x-hub-signature-256": "sha256=" },
      { "x-hub-signature-256": "sha1=deadbeef" },
      {},
    ]) {
      expect(adapter.verify!({ body: BODY, headers }), JSON.stringify(headers)).toBe(false)
    }
  })
})

describe("discord", () => {
  // Ed25519 as Discord actually uses it: the signature covers timestamp + body, and the public
  // key arrives as bare hex which the adapter has to wrap as DER before Node will take it.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicHex = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }) as Buffer,
  ).subarray(-32).toString("hex")

  const adapter = discordAdapter({ tenantSlug: "shop", botToken: "bot", publicKey: publicHex })

  const signed = (body: string, timestamp = "1700000000") => ({
    "x-signature-ed25519": Buffer.from(
      sign(null, Buffer.from(timestamp + body), privateKey),
    ).toString("hex"),
    "x-signature-timestamp": timestamp,
  })

  it("accepts a signature over the timestamp and body together", () => {
    expect(adapter.verify!({ body: BODY, headers: signed(BODY) })).toBe(true)
  })

  it("refuses a signature lifted onto a different body or timestamp", () => {
    // Replaying a valid signature over new content is the attack the timestamp is part of the
    // signed material for.
    const headers = signed(BODY)
    expect(adapter.verify!({ body: JSON.stringify({ hello: "elsewhere" }), headers })).toBe(false)
    expect(
      adapter.verify!({ body: BODY, headers: { ...headers, "x-signature-timestamp": "1700000001" } }),
    ).toBe(false)
  })

  it("refuses a signature from a different key, and anything malformed", () => {
    const other = generateKeyPairSync("ed25519")
    const foreign = Buffer.from(
      sign(null, Buffer.from("1700000000" + BODY), other.privateKey),
    ).toString("hex")

    for (const headers of [
      { "x-signature-ed25519": foreign, "x-signature-timestamp": "1700000000" },
      { "x-signature-ed25519": "not-hex", "x-signature-timestamp": "1700000000" },
      { "x-signature-ed25519": signed(BODY)["x-signature-ed25519"] },
      { "x-signature-timestamp": "1700000000" },
      {},
    ]) {
      expect(adapter.verify!({ body: BODY, headers }), JSON.stringify(headers)).toBe(false)
    }
  })
})

describe("waha", () => {
  it("verifies nothing, because WAHA signs nothing", () => {
    // Stated as a test rather than left to be discovered: a self-hosted WAHA has no signing
    // secret, so the endpoint's protection is that it should not be reachable from the internet.
    const adapter = wahaAdapter({ tenantSlug: "shop", baseUrl: "http://waha.internal" })
    expect(adapter.verify?.({ body: BODY, headers: {} }) ?? true).toBe(true)
  })
})
