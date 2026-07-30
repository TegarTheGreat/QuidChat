/** Which wire format a preset speaks. Tells the resolver which adapter factory to use. */
export type ProviderKind = "openai-compatible" | "anthropic"

/**
 * A recognized service: its wire format, default base URL, and the environment
 * variable that holds its key.
 *
 * Local runners (`ollama`, `vllm`, `lmstudio`, `llamacpp`) set `apiKeyOptional`
 * and `baseUrlVar` instead of relying on a key: they need no credential to run,
 * but the resolver still needs a signal to opt them in, and a way to point at a
 * non-default port. `baseUrlVar`, when set, both marks the preset as present
 * and overrides its default `baseUrl`.
 */
export type Preset = {
  id: string
  kind: ProviderKind
  baseUrl: string
  apiKeyVar: string
  /** Whether this service exposes an embeddings endpoint. Anthropic does not,
   *  which is exactly why `resolveProviders` must never pick it alone for embed. */
  hasEmbeddings: boolean
  apiKeyOptional?: true
  baseUrlVar?: string
  /**
   * What to ask this service for when nobody has said otherwise.
   *
   * Every tenant used to be created asking for `claude-opus-5` no matter which provider was
   * configured, so choosing Groq, DeepSeek, Together, Fireworks, OpenRouter or any local runner
   * produced `unknown_model` on every question — the product did not work at all for most of the
   * services it claims to support.
   *
   * These are starting points, not truths: model catalogues change, and a name correct today is
   * wrong next year. `listModels` asks the service what it actually offers, and the setup screen
   * reports a configured model the provider does not have, so a stale default here is a message
   * an owner can act on rather than a failure they cannot explain.
   */
  defaultChatModel: string
  /** Omitted where the service has no embeddings endpoint. */
  defaultEmbeddingModel?: string
}

/**
 * Search order used by `resolveProviders`. This order IS the contract: the
 * first preset whose key (or, for local runners, whose base-url override) is
 * present wins for chat; among those, the first with an embeddings endpoint
 * wins for embed. The order is fixed here so the winner never depends on the
 * iteration order of whatever object the caller passes as `env`.
 *
 * Anthropic is listed first: it is the preferred chat model when its key is
 * present, and since it has no embeddings endpoint, that preference only ever
 * affects chat, not embed. This is what makes "chat from Anthropic, embeddings
 * from OpenAI" the outcome when both keys are present, rather than OpenAI
 * quietly winning both roles because it comes first and can do either.
 *
 * Hosted services are listed before local runners so a real deployed key is
 * never shadowed by a stray local server left running on a developer machine.
 */
export const presets: readonly Preset[] = [
  {
    id: "anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyVar: "ANTHROPIC_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "ANTHROPIC_BASE_URL",
    // Anthropic has no embeddings endpoint. This is load-bearing: it is what
    // forces the resolver to refuse handing back Anthropic alone.
    hasEmbeddings: false,
    defaultChatModel: "claude-opus-5",
  },
  {
    id: "openai",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyVar: "OPENAI_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "OPENAI_BASE_URL",
    hasEmbeddings: true,
    defaultChatModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-small",
  },
  {
    id: "openrouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyVar: "OPENROUTER_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "OPENROUTER_BASE_URL",
    hasEmbeddings: true,
    defaultChatModel: "openai/gpt-4o-mini",
    defaultEmbeddingModel: "openai/text-embedding-3-small",
  },
  {
    id: "groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyVar: "GROQ_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "GROQ_BASE_URL",
    hasEmbeddings: false,
    defaultChatModel: "llama-3.3-70b-versatile",
  },
  {
    id: "together",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyVar: "TOGETHER_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "TOGETHER_BASE_URL",
    hasEmbeddings: true,
    defaultChatModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    defaultEmbeddingModel: "BAAI/bge-base-en-v1.5",
  },
  {
    id: "deepseek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyVar: "DEEPSEEK_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "DEEPSEEK_BASE_URL",
    hasEmbeddings: false,
    defaultChatModel: "deepseek-chat",
  },
  {
    id: "fireworks",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyVar: "FIREWORKS_API_KEY",
    // An OpenAI-compatible proxy or gateway is a very common deployment — LiteLLM,
    // a corporate gateway, Azure, or a local mock. Presence still requires the API
    // key, so setting only a base URL cannot make this preset look configured.
    baseUrlVar: "FIREWORKS_BASE_URL",
    hasEmbeddings: true,
    defaultChatModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    defaultEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5",
  },
  {
    id: "gemini",
    kind: "openai-compatible",
    // Google's own OpenAI-compatible surface, documented at ai.google.dev/gemini-api/docs/openai.
    // It speaks the same wire format as everything else here, so no separate adapter is needed —
    // which is exactly why that surface exists.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyVar: "GEMINI_API_KEY",
    baseUrlVar: "GEMINI_BASE_URL",
    hasEmbeddings: true,
    defaultChatModel: "gemini-3.6-flash",
    defaultEmbeddingModel: "gemini-embedding-001",
  },
  {
    id: "mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyVar: "MISTRAL_API_KEY",
    baseUrlVar: "MISTRAL_BASE_URL",
    // Mistral's embeddings live outside the OpenAI-compatible chat surface, so this preset is
    // treated as chat-only and must be paired with something that embeds. Claiming otherwise
    // would move the failure to the first customer question instead of to start-up.
    hasEmbeddings: false,
    defaultChatModel: "mistral-large-latest",
  },
  {
    id: "xai",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyVar: "XAI_API_KEY",
    baseUrlVar: "XAI_BASE_URL",
    hasEmbeddings: false,
    defaultChatModel: "grok-4.5",
  },
  {
    id: "ollama",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    apiKeyVar: "OLLAMA_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "OLLAMA_BASE_URL",
    defaultChatModel: "llama3.1",
    defaultEmbeddingModel: "nomic-embed-text",
  },
  {
    id: "vllm",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    apiKeyVar: "VLLM_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "VLLM_BASE_URL",
    defaultChatModel: "local-model",
    defaultEmbeddingModel: "local-model",
  },
  {
    id: "lmstudio",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKeyVar: "LMSTUDIO_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "LMSTUDIO_BASE_URL",
    defaultChatModel: "local-model",
    defaultEmbeddingModel: "text-embedding-nomic-embed-text-v1.5",
  },
  {
    id: "llamacpp",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    apiKeyVar: "LLAMACPP_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "LLAMACPP_BASE_URL",
    defaultChatModel: "local-model",
    defaultEmbeddingModel: "local-model",
  },
]
