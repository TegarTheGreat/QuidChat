# QuidChat

A chat assistant your customers can ask about **your** products and services — and that never makes anything up.

Every statement it makes about your business comes from a document you gave it, and it shows which one. When it has no source, it says so instead of guessing.

Drop it on your website with one `<script>` tag. WhatsApp, Telegram and Discord adapters follow the same core.

---

## Quick start

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# Create a business, and allow the site the widget will live on
node packages/cli/dist/main.mjs init my-shop \
  --name "My Shop" \
  --origin https://myshop.example

# Give it something to answer from
cat policy.txt | node packages/cli/dist/main.mjs add-text my-shop \
  --title "Store Policy" --stdin

node packages/cli/dist/main.mjs serve
```

Then paste this into the site you allowed:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="my-shop"
        defer></script>
```

Ask it something your document covers, and the answer arrives with the document's name attached.

## What you get

```
$ curl -s localhost:3210/v1/chat -H 'origin: https://myshop.example' \
    -H 'content-type: application/json' \
    -d '{"tenantSlug":"my-shop","message":"returns"}'

{
  "kind": "answered",
  "segments": [{
    "text": "Returns are accepted within seven days.",
    "kind": "business_claim",
    "citations": ["fbea6467-…"]
  }],
  "citations": [{ "chunkId": "fbea6467-…", "documentTitle": "Store Policy" }],
  "usage": { "inputTokens": 120, "outputTokens": 18, "cachedTokens": null }
}
```

Ask something it has no source for and you get a refusal, not an invention:

```json
{ "kind": "refused", "reason": "no_source", "text": "Sorry, I do not have that information yet…" }
```

A refusal is a `200`. It is the product working, not failing.

## Providers

Set one key. QuidChat finds it, tells you what it picked, and refuses to start if nothing usable is configured — rather than failing later on a customer's question.

| Provider | Variable | Base URL override |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` |
| Groq | `GROQ_API_KEY` | `GROQ_BASE_URL` |
| Together | `TOGETHER_API_KEY` | `TOGETHER_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| Fireworks | `FIREWORKS_API_KEY` | `FIREWORKS_BASE_URL` |
| Ollama | — | `OLLAMA_BASE_URL` |
| vLLM | — | `VLLM_BASE_URL` |
| LM Studio | — | `LMSTUDIO_BASE_URL` |
| llama.cpp | — | `LLAMACPP_BASE_URL` |

Anthropic has no embeddings endpoint, and retrieval needs one. Set `ANTHROPIC_API_KEY` **and** `OPENAI_API_KEY` and you get chat from Anthropic with embeddings from OpenAI — the pairing most people actually want. QuidChat says so on start-up rather than leaving you to discover it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3210` | `0` asks the OS for a free port |
| `DATABASE_URL` | — | Managed Postgres. Absent means embedded PGlite |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Where PGlite stores data. `memory` for ephemeral |
| `QUIDCHAT_ADMIN_TOKEN` | — | Required by the admin API; unset means admin routes refuse |

## Storage

Postgres, at every scale, from one schema and one set of migrations.

- **Trying it out** — embedded PGlite, no install, no Docker.
- **One server** — the same PGlite, on disk.
- **Growing** — point `DATABASE_URL` at managed Postgres. Nothing else changes.

PGlite is real Postgres compiled to WASM, so row-level security, `pgvector` and full-text search behave in tests exactly as they do in production. That matters more than convenience: tenant isolation is only safe if it is genuinely tested, and contributors skip tests that need Docker.

## How it refuses to make things up

1. **Retrieve** — hybrid search over your documents. Keyword and vector results are fused by rank, so an exact product name or SKU still wins even when its embedding is unremarkable.
2. **Generate** — the model answers in segments, each labelled either a general remark or a claim about your business.
3. **Validate** — every business claim must cite a chunk that retrieval actually returned. A citation the model invented, or a claim with none, is rejected. High-risk topics — price, warranty, stock, refunds — are always treated as claims regardless of how the model labelled them.
4. **Refuse** — if the answer cannot be grounded after one repair round, the assistant declines and records why.

Nothing reaches your customer unvalidated, which is why answers are not streamed token by token: validation runs on the whole answer.

## Cost control

- **Answer modes.** `full` generates. `thrifty` retrieves and quotes, without generation. `static` answers only from approved canned text and never calls the model at all.
- **Prompt caching.** The prompt is ordered stable-to-volatile so the cacheable prefix stays byte-identical between questions. Retrieved context goes last, never into the system prompt.
- **A real spend limit.** `monthly_budget_cents` is enforced *before* the provider is called, and every turn's real token usage is recorded — including refusals, which is where the expensive failures hide.

## Multi-tenant by construction

One installation, many businesses, and none can see another's data.

Isolation is row-level security, not application filters. Foreign keys carry `tenant_id` as composite keys, because foreign key checks bypass row security — which makes a cross-tenant reference impossible rather than merely forbidden. The migration refuses to apply if any table is left unprotected, and the test suite attacks that guard rather than trusting it.

## Packages

| Package | What it is |
|---|---|
| `@quidchat/core` | Pipeline, grounding validator, prompt builder. Pure: no network, no environment |
| `@quidchat/db` | Schema, migrations, tenant-scoped store |
| `@quidchat/providers` | One adapter for every OpenAI-compatible service, plus native Anthropic |
| `@quidchat/ingest` | Chunking and indexing |
| `@quidchat/server` | HTTP API |
| `@quidchat/widget` | The embeddable widget |
| `@quidchat/admin` | Admin panel |
| `@quidchat/channels` | WhatsApp, WAHA, Telegram and Discord adapters |
| `@quidchat/cli` | The `quidchat` binary |

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

After changing anything under `packages/db/migrations/`, run `pnpm generate:migrations`. The SQL is embedded in a module so applying migrations never depends on a filesystem path — a path relative to the module works only from the source tree, and a bundled binary dies on start instead. A test fails if the two copies drift.

## Licence

MIT.
