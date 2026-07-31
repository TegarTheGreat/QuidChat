import { describe, expect, it } from "vitest"
import {
  adapterFromEnv,
  adapterFromStoredSecrets,
  channelDefinition,
  channelDefinitions,
} from "./registry.js"

/**
 * One definition per channel, used by every path that needs to know about channels.
 *
 * Adding Slack and LINE meant editing six places, five of which were the same information written
 * five ways. Nothing could tell you when they disagreed — the result was a card with no inputs, or
 * a save refused by a database constraint with a message meant for an operator.
 */
describe("the channel registry", () => {
  it("builds every channel from environment variables", () => {
    for (const definition of channelDefinitions) {
      const env: Record<string, string> = {}
      for (const field of definition.fields) env[field.envVar] = `value-for-${field.name}`

      const adapter = adapterFromEnv(definition.id, "shop", env)
      expect(adapter, definition.id).not.toBeNull()
      expect(adapter!.id, definition.id).toBe(definition.id)
    }
  })

  it("builds every channel from stored credentials, using the same field names", () => {
    // The two paths reading the same names is the point: a credential saved in the panel and one
    // set in the environment reach the adapter identically, or one of them silently does not.
    for (const definition of channelDefinitions) {
      const secrets: Record<string, string> = {}
      for (const field of definition.fields) secrets[field.name] = `value-for-${field.name}`

      const adapter = adapterFromStoredSecrets(definition.id, "shop", secrets)
      expect(adapter, definition.id).not.toBeNull()
      expect(adapter!.id, definition.id).toBe(definition.id)
    }
  })

  it("refuses to build a channel missing a required credential", () => {
    for (const definition of channelDefinitions) {
      const required = definition.fields.filter((f) => f.required)
      for (const missing of required) {
        const secrets: Record<string, string> = {}
        for (const field of definition.fields) {
          if (field.name !== missing.name) secrets[field.name] = "value"
        }
        // A half-configured channel looks connected in the panel and fails on the first customer
        // message, which is the worst of both.
        expect(
          adapterFromStoredSecrets(definition.id, "shop", secrets),
          `${definition.id} without ${missing.name}`,
        ).toBeNull()
      }
    }
  })

  it("builds a channel with only its required credentials", () => {
    for (const definition of channelDefinitions) {
      const secrets: Record<string, string> = {}
      for (const field of definition.fields.filter((f) => f.required)) secrets[field.name] = "value"
      expect(adapterFromStoredSecrets(definition.id, "shop", secrets), definition.id).not.toBeNull()
    }
  })

  it("knows nothing about a channel it does not define", () => {
    expect(channelDefinition("myspace")).toBeNull()
    expect(adapterFromEnv("myspace", "shop", { ANYTHING: "x" })).toBeNull()
    expect(adapterFromStoredSecrets("myspace", "shop", { botToken: "x" })).toBeNull()
  })

  it("gives every field a label, an environment variable and a unique name", () => {
    for (const definition of channelDefinitions) {
      expect(definition.title, definition.id).toBeTruthy()
      expect(definition.hint, definition.id).toBeTruthy()
      expect(definition.fields.length, definition.id).toBeGreaterThan(0)
      expect(definition.fields.some((f) => f.required), definition.id).toBe(true)

      const names = definition.fields.map((f) => f.name)
      expect(new Set(names).size, definition.id).toBe(names.length)
      for (const field of definition.fields) {
        // A field with no label renders as its key, and a key is not what someone pasting a token
        // from another console is looking for.
        expect(field.label, `${definition.id}.${field.name}`).toBeTruthy()
        expect(field.envVar, `${definition.id}.${field.name}`).toMatch(/^[A-Z][A-Z0-9_]+$/)
      }
    }
  })
})

describe("a webhook nobody can forge", () => {
  it("requires the verifying secret on every platform that issues one", () => {
    // `verify` is optional "only because some platforms offer nothing to verify against". These
    // five all issue something, so leaving it blank made the endpoint unauthenticated: anyone
    // who learned the URL could put words into a business's history and spend its budget.
    const verifying: Record<string, string> = {
      telegram: "secretToken",
      whatsapp: "appSecret",
      discord: "publicKey",
      slack: "signingSecret",
      line: "channelSecret",
    }
    for (const [channel, field] of Object.entries(verifying)) {
      const definition = channelDefinition(channel)!
      const credential = definition.fields.find((f) => f.name === field)
      expect(credential, `${channel}.${field}`).toBeDefined()
      expect(credential!.required, `${channel}.${field}`).toBe(true)
    }
  })

  it("refuses to build one of those channels without it", () => {
    // The guarantee is structural: an adapter is only built once every required field is there,
    // so a half-configured channel cannot answer at all rather than answering unverified.
    expect(
      adapterFromStoredSecrets("slack", "shop", { botToken: "xoxb-1" }),
    ).toBeNull()
    expect(
      adapterFromStoredSecrets("slack", "shop", { botToken: "xoxb-1", signingSecret: "s" }),
    ).not.toBeNull()
  })

  it("still allows WAHA without a key, because it signs nothing", () => {
    // The exception the contract describes: a server the business runs itself, which may
    // legitimately have no key at all.
    expect(adapterFromStoredSecrets("waha", "shop", { baseUrl: "http://localhost:3000" })).not.toBeNull()
  })
})
