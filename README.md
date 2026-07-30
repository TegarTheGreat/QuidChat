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

# Or point it at a page you already have
node packages/cli/dist/main.mjs add-url my-shop https://myshop.example/delivery \
  --title "Delivery terms"

node packages/cli/dist/main.mjs serve
```

The admin panel is at **http://localhost:3210/panel** — every setting lives there, including the ones this quick start passed as flags.

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

## Channels

The website widget works out of the box. The others are opt-in — absent credentials mean the webhook route returns `404`, because a business that only uses the widget should not have a live unauthenticated WhatsApp endpoint on its server.

Point the platform at `POST /v1/channels/:channel/:tenantSlug`.

| Channel | Variables |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN` |
| WhatsApp Cloud | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` |
| WAHA (self-hosted WhatsApp) | `WAHA_BASE_URL`, `WAHA_SESSION`, `WAHA_API_KEY` |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` |

Set the signature secret. Verification runs before anything is parsed or stored, so a forged request never reaches the pipeline — without it, anyone who learns the URL can put words in a business's conversation history and spend its budget.

Every channel goes through the identical pipeline. Routing, retrieval, grounding, refusal and spend behave exactly as they do on the website, because the promise the product makes does not change with the transport.

## Giving it knowledge

Three ways in, all equivalent once the text is chunked: paste it in the panel, pipe it through `add-text`, or point at a page with `add-url` or **Knowledge → Read a page from your site**.

A page is reduced to its readable prose. Scripts and stylesheets go because they are not language — they match nothing a customer would type and cost an embedding call each. Menus, headers and footers go too: a menu repeated across ninety pages becomes ninety near-identical chunks that crowd the real answer out of the retrieval window.

Reading a URL means the server makes a request to an address someone else chose, so it is guarded rather than trusted. Only `http` and `https`. Loopback, the private ranges, carrier-grade NAT and IPv6 link-local are all refused — including `169.254.169.254`, the instance metadata endpoint that hands out cloud credentials to anything that asks. The check runs on every redirect hop, because a redirect is a second chance to name a target, and a hostname resolving to several addresses is refused if *any* of them is private. Non-text responses are refused with the type named, since a PDF embedded as binary noise costs money and makes retrieval worse.

If a page builds its content in the browser there is nothing on the wire to read. QuidChat says so and tells you to paste the text instead, rather than indexing an empty shell.

## One assistant, several jobs

A shop's sales questions and its repair questions want different sources and a different voice. A **skill** is one job: a name, optional extra instructions, and the documents it may read. A **routing rule** decides which skill takes a question — rules are evaluated in order and the first match wins.

Set both up in **Skills & routing** in the admin panel. Nothing needs a config file, and nothing needs a restart.

- A skill with **no rule pointing at it** is never selected. The panel says so on the card rather than letting you wonder.
- A skill with **no linked sources** reads everything the tenant has, not nothing — otherwise a half-configured skill would refuse every question.
- **No skills at all** is a valid setup: every question is answered from all of the tenant's documents. That is the default, and for most businesses it is the right one.
- The skill that answered is recorded on every turn, refusals included, so `Escalations` shows *which* job fell short.
- Marking a skill **handoff target** makes it the fallback when the selected skill finds nothing — bounded by `max_handoffs_per_turn` and `max_handoffs_per_conversation`, because two skills each deciding the other should answer is a loop that bills for every lap.

A skill's instructions are added to the grounding rules, never in place of them. A skill can set voice and scope; it cannot grant permission to answer without a source.

## Making it look like yours

**Settings → Widget** sets the accent colour, which side the launcher sits on, and the title your customers read. The colour is a colour picker rather than a text field, because the widget only accepts a real colour and a typed value that gets rejected reads as the setting being broken.

The widget reads those over a public endpoint, so it carries presentation only — never the refusal text, the models, the budget or the allowed origins. It validates every value again in the browser before any of it reaches CSS: a value that is not a colour cannot close a style declaration and add rules to your customer's page. A theme that fails to load, for any reason, leaves the widget looking exactly as it does by default.

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

The panel is served at `/panel` by the same process that serves the API, so an install has an interface without a second deployment. The API keeps `/admin/*`: one namespace for pages and endpoints would make every new route a question about which it is, and the first wrong guess would shadow a working endpoint with an HTML page.

`GET /health` answers `{"status":"ok"}` without touching Postgres — a liveness probe that failed while the database was briefly unreachable would make an orchestrator kill a process that was about to recover, turning a blip into an outage.

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

Nothing reaches your customer unvalidated, which is why answers are not streamed token by token: validation runs on the whole answer. What *is* streamed is the stage — "looking through our documents", "writing an answer", "checking it against our documents" — so a few seconds of waiting reads as work rather than as a hang. If the event stream cannot be used, because a proxy buffers it or the server predates the route, the widget falls back to a plain request and the visitor notices nothing.

## Cost control

- **A rate limit, not only a budget.** The budget bounds what a tenant spends in total and says nothing about how fast. Two token buckets guard every route — per visitor (10 in a burst, then one every four seconds) and per tenant (60, then two a second) — so a script with a valid slug cannot burn a month of budget in a minute. It is in-memory and therefore per process; the budget guard is the shared backstop, because that one lives in the database.
- **Answer modes.** `full` generates. `thrifty` retrieves and quotes, without generation. `static` answers only from approved canned text and never calls the model at all. Switch modes in **Settings → Answering**; it takes effect on the next question, with no restart and no redeploy.
- **Prompt caching.** The prompt is ordered stable-to-volatile so the cacheable prefix stays byte-identical between questions. Retrieved context goes last, never into the system prompt.
- **A real spend limit.** `monthly_budget_cents` is enforced *before* the provider is called, and every turn's real token usage is recorded — including refusals, which is where the expensive failures hide.

## Running without AI at all

Set the answer mode to `static` and QuidChat stops calling a model. Questions are matched against **canned answers** — exact text a person wrote — using full-text search plus trigram matching, so different wording and typos still match. It costs nothing to run and cannot invent anything, because there is nothing to invent from.

Add them in **Canned answers** in the admin panel. Every row has a state:

- **Draft** is invisible to matching. It is never sent to a customer.
- **Live** is sent word for word.

The two are separate on purpose. An answer typed into the panel is approved as it is saved, because the person typing it is the review; anything arriving another way — an import, a future AI suggestion — starts as a draft and stays silent until someone approves it. That is what makes `static` safe for price and warranty questions: every answer a customer can receive was read by a person first. Withdrawing is the same one click, because taking a wrong answer down has to be as easy as putting it up.

A `static` tenant with no live answers refuses every question. That is deliberate — the alternative is making one up.

## When it cannot answer

A refusal is the moment a person needs to take over, so the business hears about it. Choose how in **Settings → Answering**:

- **Record it here** — the default. The question lands under **Escalations** with the reason it could not be answered. Nothing is sent anywhere, which is the honest behaviour for a business that has not said where to send it.
- **Post it to a webhook** — a JSON `POST` with the customer's question, the reason and the channel. One mechanism covers Slack, Discord, n8n, Zapier, a CRM and a two-line script; email would mean SMTP credentials, a queue and bounce handling to reach a place most teams forward to chat anyway.

The notice is sent in the background. A slow relay must not make an unanswerable question slow for the customer who asked it, and a relay that is down is logged for the operator rather than turned into an error the customer sees. The question is in the payload because the reason alone says the assistant could not answer, while the question says what to write.

## Keeping only what you need

`retention_days` deletes conversations once they pass it. The server runs a pass at start-up and once a day after; `quidchat prune` does the same thing once and exits, for anyone who would rather see it in their own crontab.

Only conversations are deleted, and messages, citations and escalations follow by cascade — four separate deletes would be four chances to leave a customer's text behind under another table's name. `usage_events` is kept deliberately: it holds a model name and token counts rather than anything a customer wrote, and the monthly budget is computed from it, so pruning it would quietly hand a tenant more spend than they configured. `0` means keep forever, the same way `monthly_budget_cents = 0` means unlimited.

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

## Deploying

```bash
docker compose up
```

starts two containers: `postgres`, running `pgvector/pgvector:pg17`, and `quidchat`, built from the included `Dockerfile`. Compose starts `quidchat` only once Postgres's own healthcheck passes, not merely once the container has started — Postgres accepts TCP connections for a moment before it can actually serve a query, and starting the app in that window would misread a normal boot delay as a broken database. Provider keys still come from the host environment, exactly as in Providers above: `export OPENAI_API_KEY=sk-...` before `docker compose up`, not a value written into the compose file or the image, because either of those would sit in plain text in the image history and in anyone's `docker inspect`.

For a single machine that doesn't want a separate Postgres container, build and run the image on its own, with no `DATABASE_URL`, and it falls back to the embedded PGlite tier exactly as it does outside Docker:

```bash
docker build -t quidchat .
docker run -p 3210:3210 -e OPENAI_API_KEY=sk-... -v quidchat_data:/app/.quidchat/data quidchat
```

The named volume is not optional here for the same reason `QUIDCHAT_DATA_DIR` defaults to an on-disk path rather than memory: without it, replacing the container — an ordinary redeploy, not a failure — would silently drop every tenant's documents and conversations.

Rate limiting runs in memory, per process (see Cost control), so it is not shared across replicas. Two copies of `quidchat` behind a load balancer allow twice the configured burst and sustained rate, because each process fills its own token bucket with no knowledge of the other. The monthly budget guard doesn't have that problem: `monthly_budget_cents` is read and written in Postgres, so the same total holds no matter how many replicas are running.

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
