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
  },
  {
    id: "ollama",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    apiKeyVar: "OLLAMA_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "OLLAMA_BASE_URL",
  },
  {
    id: "vllm",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    apiKeyVar: "VLLM_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "VLLM_BASE_URL",
  },
  {
    id: "lmstudio",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKeyVar: "LMSTUDIO_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "LMSTUDIO_BASE_URL",
  },
  {
    id: "llamacpp",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    apiKeyVar: "LLAMACPP_API_KEY",
    hasEmbeddings: true,
    apiKeyOptional: true,
    baseUrlVar: "LLAMACPP_BASE_URL",
  },
]
