import type { Capabilities, CompleteResult, Provider } from "@quidchat/core"

/**
 * Routes chat work (`complete`, `generateText`, `capabilities`) to one provider
 * and `embed` to another. This is what makes the most likely real-world setup
 * possible: chat from Anthropic, embeddings from OpenAI, since Anthropic has no
 * embeddings endpoint of its own.
 *
 * `id` names both halves (e.g. `"anthropic+openai"`) so logs and error messages
 * arising from either half are traceable back to this combination.
 */
export function composite(parts: { chat: Provider; embed: Provider }): Provider {
  const { chat, embed } = parts
  return {
    id: `${chat.id}+${embed.id}`,
    complete: (args): Promise<CompleteResult> => chat.complete(args),
    generateText: (args): Promise<string> => chat.generateText(args),
    embed: (args): Promise<number[]> => embed.embed(args),
    capabilities: (model: string): Promise<Capabilities> => chat.capabilities(model),
  }
}
