import { createPublicKey, verify as verifySignature } from "node:crypto"
import { renderForChannel, type ChannelAdapter, type IncomingMessage } from "./types.js"

/**
 * Discord, via interaction webhooks.
 *
 * Discord posts an interaction object. Type 1 is PING and must be answered with type 1
 * or Discord marks the endpoint dead. Type 2 is APPLICATION_COMMAND, which is what a
 * `/ask` slash command delivers.
 *
 * Verification is Ed25519 over `timestamp + body` using the application's public key.
 * Node's `crypto.verify` supports it, but the key must be wrapped as a DER SPKI structure
 * first — Discord hands out a bare 32-byte key. The prefix below is that wrapper.
 */
export function discordAdapter(opts: {
  tenantSlug: string
  /** Application public key, hex, from the Discord developer portal. */
  publicKey?: string
  /** Bot token, for sending follow-up messages. */
  botToken: string
  fetchImpl?: typeof fetch
}): ChannelAdapter {
  const f = opts.fetchImpl ?? fetch

  return {
    id: "discord",

    parse(body: unknown): IncomingMessage | null {
      const interaction = body as {
        type?: unknown
        token?: unknown
        application_id?: unknown
        member?: { user?: { id?: unknown } }
        user?: { id?: unknown }
        data?: { options?: { name?: unknown; value?: unknown }[] }
      }

      // PING and anything that is not a command are handled by the caller, not answered
      // by the pipeline.
      if (interaction.type !== 2) return null

      const option = interaction.data?.options?.find((o) => o.name === "question")
      const text = option?.value
      if (typeof text !== "string" || text.trim() === "") return null

      // In a guild the user is under `member`; in a DM it is top level.
      const userId = interaction.member?.user?.id ?? interaction.user?.id
      const token = interaction.token
      const applicationId = interaction.application_id
      if (userId === undefined || typeof token !== "string" || typeof applicationId !== "string") {
        return null
      }

      return {
        tenantSlug: opts.tenantSlug,
        visitorId: `discord:${String(userId)}`,
        text,
        // The interaction token is what a follow-up is addressed to, and it is short
        // lived — which is why the reply must be sent promptly rather than queued.
        replyTo: `${applicationId}:${token}`,
      }
    },

    async send(message): Promise<void> {
      const [applicationId, token] = message.replyTo.split(":")
      const res = await f(
        `https://discord.com/api/v10/webhooks/${applicationId}/${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: renderForChannel({
              segments: [{ text: message.text, kind: "general" }],
              sources: message.sources,
            }),
          }),
        },
      )
      if (!res.ok) {
        throw new Error(`discord follow-up failed with ${res.status}`)
      }
    },

    verify({ body, headers }): boolean {
      if (!opts.publicKey) return true
      const sigHeader = headers["x-signature-ed25519"]
      const tsHeader = headers["x-signature-timestamp"]
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
      const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader
      if (typeof signature !== "string" || typeof timestamp !== "string") return false

      try {
        // Discord publishes a raw 32-byte Ed25519 key; Node needs DER SPKI. This prefix
        // is the SPKI header for Ed25519, so prepending it produces a key Node accepts.
        const der = Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(opts.publicKey, "hex"),
        ])
        const key = createPublicKey({ key: der, format: "der", type: "spki" })
        return verifySignature(
          null,
          Buffer.from(timestamp + body),
          key,
          Buffer.from(signature, "hex"),
        )
      } catch {
        // A malformed key or signature is a failed verification, not a crash. Throwing
        // here would turn a forged request into a 500 and hide it among real errors.
        return false
      }
    },
  }
}

/** Discord requires PING (type 1) to be answered with type 1, or it disables the endpoint. */
export function isDiscordPing(body: unknown): boolean {
  return (body as { type?: unknown }).type === 1
}
