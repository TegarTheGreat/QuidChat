# QuidChat Tech Stack Research

**Date:** 2026-07-29
**Status:** Research complete — awaiting architecture decisions
**Target users:** beginner → enthusiast → enterprise. Must be solid for production, easy to use, and universal.

---

## 1. Methodology

Every star count, language, and license is pulled directly from the **GitHub API** (`api.github.com/repos/...`), not from blog posts. The tech stack is verified from the actual `package.json` / `pyproject.toml` on each repo's default branch. Some early search results turned up AI-generated SEO pages with inaccurate claims — every claim in this document has a primary source.

**Not** verified directly, and flagged as estimates: vector database performance (from third-party benchmarks) and language adoption trends.

---

## 2. Landscape of comparison projects

| Project | Language | Stars | License | Created | Category |
|---|---|---:|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | TypeScript | 384,486 | MIT | 2025-11 | Personal AI assistant / multi-channel gateway |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | Python | 222,299 | MIT | 2025-07 | Self-improving agent, persistent memory |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | TypeScript | 75,090 | MIT | 2026-03 | Agent team orchestrator |
| [666ghj/MiroFish](https://github.com/666ghj/MiroFish) | Python | 69,680 | **AGPL-3.0** | 2025-11 | Swarm simulation / prediction engine |
| [opencode](https://opencode.ai) (`sst/opencode`) | TypeScript | — | MIT | 2025 | Coding agent (TUI + desktop) |
| [camel-ai/oasis](https://github.com/camel-ai/oasis) | Python | 4,972 | Apache-2.0 | 2024-11 | Simulation engine underneath MiroFish |
| 9Router | JavaScript | ~24k | — | 2026 | LLM router, OpenAI-compatible API |

**Important note on `opencode`:** there are two repos with the same name. `opencode-ai/opencode` (Go, 13,591 stars) is **no longer active** — last commit 2025-09-18. The active one is `sst/opencode` (TypeScript), whose API URL has already moved. Don't cite the wrong one.

**License notes:**
- OpenClaw shows as `NOASSERTION` in the GitHub API, but its `LICENSE` file is **MIT** (© OpenClaw Foundation) and `package.json` states `"license": "MIT"`. There's likely a `THIRD_PARTY_NOTICES.md` that confuses GitHub's license detector.
- **MiroFish is AGPL-3.0** — this is a viral license. If QuidChat took code from MiroFish, QuidChat would have to become AGPL too. QuidChat is already MIT, so **MiroFish can only be a source of ideas to reference, never a source of code.**

---

## 3. Verified tech stacks

### 3.1 OpenClaw — the most relevant comparison (TypeScript, 384k stars)

From `package.json` (version `2026.7.2`, date-based versioning):

| Layer | Choice |
|---|---|
| Runtime | Node.js `>=22.22.3` (also accepts 24.x / 25.x) |
| Package manager | **pnpm 11** (workspace / monorepo) |
| Query builder | **kysely** `0.29.4` — not a full ORM |
| Vector store | **`sqlite-vec` 0.1.9 (optionalDependency)** — embedded, not a server |
| Tool protocol | `@modelcontextprotocol/sdk` (MCP) `1.30.0` |
| Client protocol | `@agentclientprotocol/sdk` (ACP) `1.3.0` |
| LLM providers | Direct per-provider SDKs: `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@mistralai/mistralai` |
| HTTP server | `express` 5.2.1 |
| Channel | `grammy` (Telegram) + `@grammyjs/runner`, `@grammyjs/transformer-throttler` |
| Scheduler | `croner` 10.0.1 |
| Process | `execa` 10, `@lydell/node-pty` |
| UI | **Lit 3** (web components) + `vite` 8 + `shiki` (syntax highlighting) |
| Lint/format | **`oxlint` + `oxfmt`** (Rust-based, very fast) |
| Test | `vitest` 4 + `playwright` |
| Build | `tsdown`, `esbuild` |
| Supply chain | **`sigstore` 5.0.0** (release artifact signing) |

Its architecture is **plugin-first**: there's a `plugin-sdk` exporting hundreds of `.d.ts` files, plus `schemaVersions: { state: 6, agent: 16 }` in `package.json` — meaning agent state and config have **versioned migrations**. This is a mature pattern; a framework that stores agent state with no versioning will break on upgrade.

### 3.2 Hermes Agent — the Python comparison (222k stars)

From `pyproject.toml` (version `0.19.0`):

| Layer | Choice |
|---|---|
| Runtime | Python `>=3.11,<3.14` (the upper bound is *load-bearing*, not cosmetic) |
| Package manager | **`uv`** (Astral, Rust-based) |
| Core LLM client | **`openai==2.24.0`** — used as a universal client |
| Provider-specific | `anthropic`, `firecrawl-py`, `exa-py`, `fal-client` → **extras, lazy-installed** via `tools/lazy_deps.py` |
| Validation | `pydantic==2.13.4` |
| HTTP | `httpx[socks]==0.28.1` |
| CLI | `fire`, `rich`, `prompt_toolkit` |
| Scheduler | `croniter==6.0.0` |
| Storage | **SQLite + FTS5** (cross-session full-text search) |
| Memory | **Honcho** integration (dialectic user modeling) |

**Two big lessons from Hermes:**

1. **Every dependency is pinned to an exact version (`==X.Y.Z`), no ranges.** A comment in `pyproject.toml` explains why: on 2026-05-12 the *Mini Shai-Hulud* worm hit `mistralai 2.4.6` on PyPI. If the version had been written as `mistralai>=2.3.0,<3`, every install in the hours before quarantine would have pulled the infected package. This isn't theoretical paranoia — it's a real incident.

2. **Dependency-scoping rule:** *"only packages used in EVERY session go in `dependencies`."* Everything else becomes an extra installed only when the user selects that backend. A smaller core dependency set means a smaller blast radius for the next supply-chain attack.

### 3.3 Paperclip — the answer key for "beginner to enterprise"

`packages/db/package.json`:

```json
"dependencies": {
  "drizzle-orm": "^0.45.2",
  "embedded-postgres": "^18.1.0-beta.16",
  "postgres": "^3.4.9"
}
```

This pattern answers QuidChat's requirement directly: **embedded Postgres for beginners, real Postgres for enterprises, one dialect and one schema for both.** A beginner runs `npm install` and it just works — no database server to install. An enterprise points `DATABASE_URL` at their own Postgres cluster. The application code doesn't change at all.

Paperclip also has `check:migrations`, which runs `check-migration-numbering.ts` and `check-migration-safety.ts` on every build — migrations are validated automatically, not checked by hand.

The rest: a pnpm monorepo (`@paperclipai/server`, `/ui`, `/db`, `/plugin-sdk`, `/shared`), `tsx`, `vitest` 4, Playwright e2e, Storybook + visual regression, and **`promptfoo`** for LLM evaluation.

The most interesting bit: Paperclip's `package.json` has scripts named `smoke:openclaw-join`, `smoke:openclaw-docker-ui`, `smoke:hermes-gateway-e2e`. **Paperclip runs smoke tests against OpenClaw and Hermes.** This means the 2026 ecosystem is already interconnected — Paperclip as the orchestrator, OpenClaw and Hermes as runtimes, with MCP and ACP as the protocols in between.

---

## 4. Convergent patterns

Four patterns show up across all the major projects, regardless of language:

1. **The agent loop is hand-written, not built on LangChain.** None of the four biggest projects uses LangChain/LlamaIndex as its core. OpenClaw even markets itself with *"No Python, no chains, no graphs."* Generic framework abstractions turn out to be a burden, not a help, for a chat runtime.

2. **Embedded storage first, a server later.** OpenClaw: SQLite + `sqlite-vec`. Hermes: SQLite + FTS5. Paperclip: embedded Postgres → real Postgres. None of them require the user to install a database server just to try the product.

3. **Provider-agnostic via adapters, not lock-in.** Either through per-provider SDKs (OpenClaw) or a single universal client + lazy extras (Hermes).

4. **MCP + ACP as the interop standard.** OpenClaw includes both as core dependencies. A new framework that doesn't speak MCP will be isolated from the existing tool ecosystem.

---

## 5. QuidChat stack recommendation

### 5.1 Language: TypeScript (Node 22+, Bun-compatible)

**Reasons:**

- The three most-adopted projects in exactly this category (chat agent runtime) are all TypeScript: OpenClaw 384k, Paperclip 75k, opencode.
- **One language across every surface** — agent runtime, CLI, web UI, and browser. This is what makes "universal" real rather than a slogan. PGlite can even run in the browser, so a QuidChat demo can live with no backend at all.
- **The friendliest install path for beginners:** `npm i -g quidchat`. Python's venv/uv/PATH concerns often trip up beginners at the very first step.
- Mature, fast tooling: oxlint/oxfmt (Rust), vitest, tsdown.

**Trade-off, stated honestly:** Python has a much deeper ML ecosystem, and Hermes proves Python is very viable in this category (222k stars). But a chat framework **doesn't train models** — it calls embedding APIs and LLM APIs. If heavy ML work is ever needed (fine-tuning a reranker, local embeddings), the right pattern is a **Python sidecar** called over HTTP, not rewriting the entire runtime in Python.

### 5.2 Storage: Postgres at every tier

This is the single most important decision in this document. **One schema, one dialect, three deployment tiers.**

| Tier | Target | Storage | Install |
|---|---|---|---|
| **1 — Beginner** | Trying it out, demos, browser | **PGlite** (`@electric-sql/pglite`) — Postgres compiled to WASM, <3MB gzipped | `npm install`, zero configuration |
| **2 — Enthusiast** | Serious local dev, small self-hosting | **`embedded-postgres`** — real Postgres binary, managed by the QuidChat process | Automatic on first run |
| **3 — Enterprise** | Production, multi-tenant | Any Postgres (RDS / Neon / Supabase / self-hosted) + pgvector + AGE | `DATABASE_URL` |

All three speak the same Postgres wire protocol. **One Drizzle schema, one migration set, zero code branches per tier.**

**What makes this work:** PGlite supports the extensions we need (verified from [pglite.dev/extensions](https://pglite.dev/extensions/)):

| Extension | Package | Size | Role in QuidChat |
|---|---|---|---|
| pgvector | `@electric-sql/pglite-pgvector` | 42.9 KB | RAG — vector similarity search |
| Apache AGE | `@electric-sql/pglite-age` | 138.2 KB | Graph — openCypher on top of Postgres |

So **a single database holds four layers at once**: conversation state (plain tables), RAG (pgvector), graph memory (AGE), and keyword search (Postgres FTS for hybrid search).

**ORM: Drizzle** (`drizzle-orm` + `drizzle-kit`) — same as Paperclip. TypeScript-native, migrations are SQL files that land in the repo (reviewable in a PR), no magic codegen. The alternative is Kysely (used by OpenClaw), but Drizzle wins because its migrations are cleaner for a project that will take external contributions.

**PGlite's limits, stated honestly:** PGlite is a *library*, not a server — **one connection, one process.** Fine for single-user local use, **not for multi-user production.** This is exactly why the tiering needs to exist, not a design flaw. QuidChat's documentation must state this explicitly so no one deploys Tier 1 to production.

### 5.3 RAG: pgvector + Postgres FTS (hybrid)

- **Index:** HNSW. Use `halfvec` when embedding dimensions are large (saves ~50% storage).
- **Hybrid search:** combine pgvector (semantic) with Postgres full-text search (keyword), then rerank. This consistently beats vector-only in practice.
- **When pgvector is enough:** third-party research consistently rates pgvector the best choice **under ~5 million vectors** with ACID requirements; with HNSW and proper tuning it still handles tens of millions of vectors at sub-100ms P95.
- **When it isn't enough:** heavy, complex metadata filtering. A third-party benchmark (EC2 g4dn.xlarge, 5 million 768-dim vectors) shows Qdrant at ~12ms p99 for filtered ANN vs pgvector at ~34ms. **This number is from a blog and I haven't re-verified it** — treat it as directional, not final fact.

**Design consequence:** build **`VectorStore` as an interface** with pgvector as the default implementation, plus a Qdrant adapter for anyone who needs heavier scale/filtering. The abstraction boundary is thin: `upsert`, `query`, `delete`, `createIndex`.

One important note from the research: *"vector database choice matters far less than people think — chunking strategy and the retrieval pipeline matter far more."* Don't spend time arguing about the vector DB; spend it on chunking and reranking.

### 5.4 Graph: Apache AGE — the riskiest layer

**Recommendation: Apache AGE in the same Postgres instance, behind an adapter.**

The upside is big: graph and vector in one transaction, one backup, one connection. No separate Neo4j for a beginner to run.

**But this is the highest-risk part of the whole stack, and I need to say so plainly:**

- AGE's support for Postgres versions has historically **lagged** behind Postgres releases. This means QuidChat could get locked to a specific Postgres version.
- The WASM build of AGE for PGlite is relatively young compared to pgvector.
- If AGE turns out to be a problem, the alternatives are: Neo4j (most mature, but JVM — higher baseline latency and heavier operationally), or Kuzu (embedded, fast, but a smaller ecosystem).

**Because of this: `GraphStore` must be an interface from day one.** This is the only layer where I'm recommending abstraction *before* there's a second need for it, precisely because the odds of having to swap it out are genuinely real.

**A clarification that must be settled before writing code:** "graph" has two very different meanings that often get conflated.

| | Graph as **orchestrator** | Graph as **memory** |
|---|---|---|
| Example | LangGraph | GraphRAG, Graphiti, Zep |
| Contents | node = execution step | node = entity, edge = relationship |
| Needs | state machine + persistence | a graph database (AGE / Neo4j) |
| Recommendation | **Plain TypeScript code + a state machine.** No graph DB needed. | **AGE.** This is where a graph DB is genuinely needed. |

For orchestration, both OpenClaw and Paperclip skip a graph DB entirely — plain code and versioned state is enough. Putting loop execution inside a graph DB adds complexity with no payoff.

### 5.5 LLM layer: embrace every provider, zero-configuration setup

**Target:** the user runs `quidchat`, and QuidChat immediately discovers on its own which models are available on that machine — with zero configuration questions asked. What feels "magic" isn't sorcery, it's **credential auto-detection + a data-driven provider registry.**

#### 5.5.1 Principle: two adapters, not twenty

Almost the entire 2026 ecosystem speaks an **OpenAI-compatible API** — including 9Router, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, Groq, Together, DeepSeek, Cerebras, xAI, Fireworks. So maximum coverage comes from **one** adapter, not one adapter per vendor.

| Adapter | Coverage | Implementation |
|---|---|---|
| **`openai-compatible`** | ~90% of the ecosystem: every router, every local server, most cloud providers | One HTTP client + a `baseURL` registry |
| **`anthropic`** | Claude — features with no equivalent in the OpenAI format | `@anthropic-ai/sdk` |

Anthropic gets its own adapter because some of its features **can't be expressed** through an OpenAI-compatible shim, and those features are exactly the ones that most determine agent-loop cost and quality: `thinking: {type: "adaptive"}`, `output_config.effort`, prompt caching with `cache_control` breakpoints, and `task_budget`. Forcing them through a shim would lose all of it.

> Other providers with unique features (Google `@google/genai`, Mistral) become **optional packages** installed only when selected — following Hermes's dependency-scoping rule. Core dependencies stay small.

#### 5.5.2 A data-driven provider registry, not code

Don't write one TypeScript file per provider. Build a **declarative registry** — a new provider is just one data entry, no code touched:

```jsonc
{
  "id": "9router",
  "label": "9Router",
  "adapter": "openai-compatible",
  "baseURL": "https://api.9router.com/v1",
  "envKeys": ["NINEROUTER_API_KEY", "NINE_ROUTER_API_KEY"],
  "modelsEndpoint": "/models",   // automatic model enumeration
  "isRouter": true
}
```

`opencode` uses a similar approach (an external model registry), and that's exactly how it supports so many providers without bloating. This registry can be **bundled as a default and overridden by the user**, so new providers don't have to wait for a QuidChat release.

#### 5.5.3 The credential auto-detection ladder

Run once at startup, stopping at the first match per provider:

**Tier 1 — Environment variable.** For every registry entry, check its `envKeys`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NINEROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, `CEREBRAS_API_KEY`, `OLLAMA_HOST`, and so on.

**Tier 2 — Existing OAuth session.** This is the part that feels the most magic, and the one most often skipped. For Anthropic, the official credential resolution order is:

```
ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → active OAuth profile (ant auth login)
  → Workload Identity Federation → default profile on disk
```

In other words: **a user who's already run `ant auth login` doesn't need an API key at all.** The `new Anthropic()` constructor with no arguments automatically reads the profile at `~/.config/anthropic/`. QuidChat just calls `ant auth status` to detect the active profile, then stays quiet and works.

Trap that must be handled: **a stale exported `ANTHROPIC_API_KEY` overrides every OAuth profile** — even an empty `ANTHROPIC_API_KEY=""` still wins in the priority order. If QuidChat detects both, it must warn the user, not fail mysteriously.

**Tier 3 — Local server probe.** Check common ports in parallel with a short timeout (~300ms):

| Service | Port | Probe endpoint |
|---|---:|---|
| Ollama | 11434 | `/api/tags` |
| LM Studio | 1234 | `/v1/models` |
| vLLM | 8000 | `/v1/models` |
| llama.cpp server | 8080 | `/v1/models` |
| Jan / others | 1337 | `/v1/models` |

Whatever responds is immediately usable — **no API key, no configuration, no cost.** This is the best path for the beginner tier: someone with Ollama installed can use QuidChat for free within seconds.

**Tier 4 — Import from other tools' configuration.** If the user already uses OpenClaw, opencode, Hermes, or Claude Code, their credentials and model preferences already exist on disk. QuidChat **reads (read-only) and offers to import**:

```
$ quidchat
✓ Ollama detected at localhost:11434 (3 models)
✓ Anthropic OAuth profile active (ant auth login)
✓ OpenClaw detected — import 2 providers? [Y/n]
✓ 9Router API key found in environment

Ready. 4 providers, 47 models. Default model: claude-opus-5
```

**Hard rule for Tier 4:** read only, **never write** to another tool's configuration, and **never copy secrets** into QuidChat's own configuration. Store a *reference* to the source (e.g. "read from env `OPENROUTER_API_KEY`"), not the value. QuidChat's configuration must be safe even if accidentally committed — and `.gitignore` still protects it as a second layer.

#### 5.5.4 Capabilities are asked for, not guessed

Don't hardcode context window, pricing, or feature support — all of it changes every few months and hardcoding it goes stale silently.

- **Anthropic:** call the Models API (`client.models.retrieve(id)`), which returns `max_input_tokens`, `max_tokens`, and a `capabilities` tree with `supported: true/false` at every leaf (thinking, effort, vision, structured outputs, etc.).
- **OpenAI-compatible:** call `GET /v1/models` for enumeration; capabilities beyond that are detected via *probing* or declared in the registry.

The `Provider` interface reports the result upward:

```ts
interface Provider {
  readonly id: string
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
  countTokens(req: ChatRequest): Promise<number>
  capabilities(model: string): Promise<{
    contextWindow: number
    maxOutput: number
    tools: boolean
    vision: boolean
    thinking: boolean
    promptCaching: false | { minPrefixTokens: number; maxBreakpoints: number }
  }>
}
```

`minPrefixTokens` **must** come from here, not a constant: the minimum cacheable prefix is **not monotonic across model generations** — 512 tokens on Opus 5, 1024 on Opus 4.8/Sonnet 5, 4096 on Opus 4.6/Haiku 4.5. A prompt below the minimum **fails to cache with no error at all**; the only symptom is `cache_creation_input_tokens: 0`.

#### 5.5.5 Don't rebuild routing — a router is a provider

9Router and OpenRouter have already solved cross-provider routing: auto-retry, fallback, cost dashboards, one API for hundreds of models. **QuidChat must not compete with that.** Treat a router as an ordinary provider with an `isRouter: true` flag, then QuidChat adds the layer a router can't:

| Layer | Owner |
|---|---|
| Cross-provider routing, retry, cost dashboard | **Router** (9Router / OpenRouter) |
| Failover *across routers* (if the router itself goes down) | **QuidChat** |
| Degrading to a local model when offline | **QuidChat** |
| Per-role model selection (chat / summarization / embed) | **QuidChat** |
| Correct per-provider prompt caching | **QuidChat** |

Failing over to a local model when offline is a genuine selling point: QuidChat stays alive on a plane or when an API is down.

#### 5.5.6 Default model

Default to the best model available, not the cheapest — saving money is the user's decision, not the framework's. If Anthropic credentials are detected, default to `claude-opus-5` (1M context, $5/$25 per MTok, 128K max output) with `thinking: {type: "adaptive"}` and streaming for large `max_tokens`.

One Opus-5-specific trap the adapter must handle: **thinking is on by default**, and `max_tokens` caps *thinking + answer text combined*. A route that previously never enabled thinking and set a tight `max_tokens` will get cut off mid-answer. Never lowball `max_tokens` — default ~16K for non-streaming, ~64K for streaming.

### 5.6 Prompt caching — a constraint that must shape the architecture, not get patched in later

This is the finding with the biggest impact on QuidChat's internal design, and the one most agentic frameworks overlook.

The prompt cache is a **prefix match**. Render order: `tools` → `system` → `messages`. **One byte changing at position N invalidates the cache for everything after N.** The economics: cache reads cost ~0.1× the input price, cache writes cost 1.25× (5-minute TTL). For an agent loop that resends the entire history every iteration, this isn't a minor optimization — it's the difference between a framework that's cheap and one that burns money.

Rules that must be enforced in QuidChat's prompt-builder layer:

| Rule | Why |
|---|---|
| **The system prompt must be frozen** | Inserting `new Date()` or a user's name into the system prompt invalidates the entire cache behind it, on every request |
| **The tool set must not change mid-conversation** | `tools` renders at position 0 — adding, removing, or reordering a single tool invalidates the *entire* cache |
| **Serialization must be deterministic** | `JSON.stringify` over an object with unstable key order, or iterating a `Set`, produces different bytes → a silent cache miss |
| **Dynamic context goes into `messages`, not `system`** | A message at turn 5 doesn't invalidate anything before turn 5 |
| **Maximum 4 breakpoints per request** | API limit |
| **Lookback is only 20 content blocks** | **This is a trap specific to agent loops:** one turn with many `tool_use`/`tool_result` pairs can easily exceed 20 blocks, so the next breakpoint fails to find the earlier cache and misses silently. Fix: insert a breakpoint roughly every ~15 blocks on long turns. |

**Mandatory verification:** expose `usage.cache_read_input_tokens` in QuidChat's telemetry. If it's zero on a repeated request with an identical prefix, there's a *silent invalidator* — and without this metric, no one will ever notice.

The minimum cacheable prefix is **not monotonic across model generations**: 512 tokens on Opus 5, 1024 on Opus 4.8/Sonnet 5, 4096 on Opus 4.6/Haiku 4.5. So the `Provider` interface's `capabilities()` needs to report this number, never hardcode it.

### 5.7 Interop: MCP + ACP from the start

- **MCP** (`@modelcontextprotocol/sdk`) — the tool protocol. This is what gives QuidChat access to hundreds of existing tools without writing a single integration. Non-negotiable.
- **ACP** (`@agentclientprotocol/sdk`) — the client protocol. Lets QuidChat be used from other editors/clients. OpenClaw includes it; Paperclip smoke-tests against it. This is the direction the ecosystem is heading.

### 5.8 Dataset & evaluation

"Dataset" for a chat framework means an **eval set**, not training data:

- **`promptfoo`** — used by Paperclip (`evals:smoke`). Declarative, runs in CI.
- **Golden conversation set** — a set of labeled conversations in the repo, so prompt changes can be measured rather than felt.
- **Separate RAG eval**: recall@k and MRR for retrieval, scored apart from generation quality. If mixed together, a retrieval regression gets hidden behind an LLM that papers over it.

### 5.9 Tooling & release

| Need | Choice | Source |
|---|---|---|
| Monorepo | **pnpm workspaces** | OpenClaw + Paperclip |
| Test | **vitest 4** | both |
| E2E | **Playwright** | both |
| Lint/format | **oxlint + oxfmt** | OpenClaw — Rust-based, much faster than ESLint |
| Build | **tsdown** | OpenClaw |
| Dev runner | **tsx** | Paperclip |
| Release signing | **sigstore** | OpenClaw |
| Versioning | Consider date-based (`2026.7.2`) | OpenClaw |

### 5.10 Supply chain security — an expensive lesson available for free

From Hermes's `pyproject.toml` comments, written after a real incident:

1. **Pin dependencies to exact versions.** Ranges let the registry ship a new transitive version with no review on our side.
2. **Keep core dependencies small.** Anything provider-specific becomes optional, installed only when selected.
3. **Commit the lockfile** (`pnpm-lock.yaml`) and use `--frozen-lockfile` in CI.
4. **Sign release artifacts** with sigstore.
5. **Enable Dependabot/Renovate** with manual review — not auto-merge.

For an open-source framework that thousands of people will `npm install`, this isn't optional. QuidChat is a supply chain for its users.

---

## 6. Recommendation summary

| Layer | Choice | Confidence |
|---|---|---|
| Language | TypeScript, Node 22+ | **High** — the 3 biggest projects in this category are all TS |
| Monorepo | pnpm workspaces | **High** — OpenClaw + Paperclip |
| Database | Postgres at every tier (PGlite → embedded-postgres → managed) | **High** — Paperclip's pattern, proven |
| ORM | Drizzle | **High** |
| RAG | pgvector + Postgres FTS, behind a `VectorStore` interface | **High** |
| Graph | Apache AGE, **mandatory** behind a `GraphStore` interface | **Medium** — the riskiest layer |
| Agent loop | Hand-written code, not LangChain | **High** — no major project uses it |
| LLM | 2 adapters (`openai-compatible` + `anthropic`) + a declarative provider registry | **High** |
| Provider setup | 4-tier auto-detection: env → OAuth → local probe → import from other tools' config | **High** |
| Routing | Treat 9Router/OpenRouter as providers; QuidChat only adds cross-router failover + local fallback | **High** |
| Interop | MCP + ACP | **High** |
| Eval | promptfoo + golden set | **Medium** |

---

## 7. What's still to be decided (not a research finding — needs a decision)

1. **Graph: orchestrator or memory?** If both, they need to be two separate subsystems with different names. Conflating them is the most common design mistake in agentic frameworks.
2. **Who holds conversation state?** This determines whether QuidChat can *resume*, *replay*, and be *observable*. OpenClaw chose versioned state with migrations (`schemaVersions`) — a pattern worth copying.
3. **How does the loop stop?** Iteration limits, unchanged-state detection, and *token budgets*. This is what separates a production framework from one that burns tokens without bound.
4. **Shape of the plugin API.** OpenClaw exports a large `plugin-sdk`; Paperclip has `@paperclipai/plugin-sdk`. A plugin API surface is a long-term compatibility commitment — hard to change once released.
5. **Which channels ship in v1?** OpenClaw supports Telegram/Discord/WhatsApp via `grammy` and friends. Adding one channel is easy; supporting all of them from day one is a scope trap.

---

## 8. Sources

Repositories (data via GitHub API, `package.json`/`pyproject.toml` via raw.githubusercontent.com):
- https://github.com/openclaw/openclaw
- https://github.com/NousResearch/hermes-agent
- https://github.com/paperclipai/paperclip
- https://github.com/666ghj/MiroFish
- https://github.com/camel-ai/oasis
- https://github.com/opencode-ai/opencode (inactive) · https://opencode.ai

Documentation:
- https://pglite.dev/docs/about · https://pglite.dev/extensions/
- https://github.com/pgvector/pgvector
- https://github.com/electric-sql/pglite

Third-party comparisons (not re-verified — treat as indicative):
- https://4xxi.com/articles/vector-database-comparison/
- https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb
- https://www.firecrawl.dev/blog/best-vector-databases
- https://graphindex.io/blog/neo4j-memgraph-kuzu-benchmark
- https://blaxel.ai/blog/typescript-vs-python-ai-agents
