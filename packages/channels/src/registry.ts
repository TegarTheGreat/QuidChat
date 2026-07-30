import { discordAdapter } from "./discord.js"
import { lineAdapter } from "./line.js"
import { slackAdapter } from "./slack.js"
import { telegramAdapter } from "./telegram.js"
import { wahaAdapter, whatsappCloudAdapter } from "./whatsapp.js"
import type { ChannelAdapter } from "./types.js"

/**
 * Every channel, defined once.
 *
 * Adding Slack and LINE meant editing six places: two switch statements in the server, the
 * credential list the admin API serves, the union in the panel's API client, the panel's own list
 * of cards, and the database's CHECK constraint. Five of those six are the same information
 * written five ways, so the compiler cannot tell you when they disagree — it just serves a card
 * with no inputs, or refuses a save with a database error meant for an operator.
 *
 * A definition carries what a channel needs and how to build it. The server reads credentials
 * from the environment or from a tenant's stored secrets using the SAME field names, so the two
 * paths cannot drift; the admin API serves the field list straight from here; and the panel
 * renders whatever the API says rather than a list of its own. Channel number seven is one entry
 * in this file plus a line in a migration.
 */

export type CredentialField = {
  /** The key in stored secrets, and in the JSON the panel sends. */
  name: string
  /** What a person setting it up should see, rather than the key. */
  label: string
  /** Where the same credential is read from when it is configured for the whole deployment
   *  rather than per tenant. */
  envVar: string
  required: boolean
  /** False for a value that is not a secret, so the panel can show it as ordinary text — an
   *  address or a session name is not something to hide behind dots. */
  secret?: boolean
}

export type ChannelDefinition = {
  id: string
  /** Shown as the card's heading. */
  title: string
  /** One sentence on where these credentials come from, which is the part nobody remembers. */
  hint: string
  fields: CredentialField[]
  /** Builds the adapter from credentials that are already known to be complete. */
  create: (args: { tenantSlug: string; secrets: Record<string, string> }) => ChannelAdapter
}

/** Only the values actually present, so an optional field left blank is absent rather than "". */
function present(secrets: Record<string, string>, name: string): Record<string, string> {
  const value = secrets[name]
  return value !== undefined && value !== "" ? { [name]: value } : {}
}

export const channelDefinitions: readonly ChannelDefinition[] = [
  {
    id: "telegram",
    title: "Telegram",
    hint: "Create a bot with @BotFather, then set its webhook to the URL below.",
    fields: [
      { name: "botToken", label: "Bot token", envVar: "TELEGRAM_BOT_TOKEN", required: true, secret: true },
      { name: "secretToken", label: "Webhook secret", envVar: "TELEGRAM_SECRET_TOKEN", required: false, secret: true },
    ],
    create: ({ tenantSlug, secrets }) =>
      telegramAdapter({ tenantSlug, botToken: secrets.botToken!, ...present(secrets, "secretToken") }),
  },
  {
    id: "whatsapp",
    title: "WhatsApp (Cloud API)",
    hint: "From Meta's WhatsApp Business setup: the phone number id and a permanent access token.",
    fields: [
      { name: "phoneNumberId", label: "Phone number ID", envVar: "WHATSAPP_PHONE_NUMBER_ID", required: true },
      { name: "accessToken", label: "Access token", envVar: "WHATSAPP_ACCESS_TOKEN", required: true, secret: true },
      { name: "appSecret", label: "App secret", envVar: "WHATSAPP_APP_SECRET", required: false, secret: true },
    ],
    create: ({ tenantSlug, secrets }) =>
      whatsappCloudAdapter({
        tenantSlug,
        phoneNumberId: secrets.phoneNumberId!,
        accessToken: secrets.accessToken!,
        ...present(secrets, "appSecret"),
      }),
  },
  {
    id: "waha",
    title: "WhatsApp (self-hosted WAHA)",
    hint: "The address of your own WAHA server. It runs Baileys, so this is the self-hosted WhatsApp path.",
    fields: [
      { name: "baseUrl", label: "Server address", envVar: "WAHA_BASE_URL", required: true },
      { name: "session", label: "Session name", envVar: "WAHA_SESSION", required: false },
      { name: "apiKey", label: "API key", envVar: "WAHA_API_KEY", required: false, secret: true },
    ],
    create: ({ tenantSlug, secrets }) =>
      wahaAdapter({
        tenantSlug,
        baseUrl: secrets.baseUrl!,
        ...present(secrets, "session"),
        ...present(secrets, "apiKey"),
      }),
  },
  {
    id: "discord",
    title: "Discord",
    hint: "From your Discord application: the bot token and its public key.",
    fields: [
      { name: "botToken", label: "Bot token", envVar: "DISCORD_BOT_TOKEN", required: true, secret: true },
      { name: "publicKey", label: "Public key", envVar: "DISCORD_PUBLIC_KEY", required: false },
    ],
    create: ({ tenantSlug, secrets }) =>
      discordAdapter({ tenantSlug, botToken: secrets.botToken!, ...present(secrets, "publicKey") }),
  },
  {
    id: "slack",
    title: "Slack",
    hint: "From your Slack app: the bot token (xoxb-…) and the signing secret. Subscribe it to message events and point them at the URL below.",
    fields: [
      { name: "botToken", label: "Bot token", envVar: "SLACK_BOT_TOKEN", required: true, secret: true },
      { name: "signingSecret", label: "Signing secret", envVar: "SLACK_SIGNING_SECRET", required: false, secret: true },
    ],
    create: ({ tenantSlug, secrets }) =>
      slackAdapter({ tenantSlug, botToken: secrets.botToken!, ...present(secrets, "signingSecret") }),
  },
  {
    id: "line",
    title: "LINE",
    hint: "From the LINE Developers console: the channel access token and the channel secret.",
    fields: [
      { name: "accessToken", label: "Channel access token", envVar: "LINE_ACCESS_TOKEN", required: true, secret: true },
      { name: "channelSecret", label: "Channel secret", envVar: "LINE_CHANNEL_SECRET", required: false, secret: true },
    ],
    create: ({ tenantSlug, secrets }) =>
      lineAdapter({ tenantSlug, accessToken: secrets.accessToken!, ...present(secrets, "channelSecret") }),
  },
]

export function channelDefinition(id: string): ChannelDefinition | null {
  return channelDefinitions.find((c) => c.id === id) ?? null
}

/** Whether every required credential is there. Building an adapter without one produces a channel
 *  that looks connected and fails on the first customer message. */
export function hasRequiredFields(definition: ChannelDefinition, secrets: Record<string, string>): boolean {
  return definition.fields
    .filter((f) => f.required)
    .every((f) => typeof secrets[f.name] === "string" && secrets[f.name] !== "")
}

/**
 * Builds a channel from the environment.
 *
 * The same definition that describes the panel's form reads the environment here, so a credential
 * cannot be named one thing in one place and another elsewhere.
 */
export function adapterFromEnv(
  channel: string,
  tenantSlug: string,
  env: Record<string, string | undefined>,
): ChannelAdapter | null {
  const definition = channelDefinition(channel)
  if (!definition) return null

  const secrets: Record<string, string> = {}
  for (const field of definition.fields) {
    const value = env[field.envVar]
    if (value !== undefined && value !== "") secrets[field.name] = value
  }
  if (!hasRequiredFields(definition, secrets)) return null
  return definition.create({ tenantSlug, secrets })
}

/** Builds a channel from a tenant's stored credentials. */
export function adapterFromStoredSecrets(
  channel: string,
  tenantSlug: string,
  secrets: Record<string, string>,
): ChannelAdapter | null {
  const definition = channelDefinition(channel)
  if (!definition || !hasRequiredFields(definition, secrets)) return null
  return definition.create({ tenantSlug, secrets })
}
