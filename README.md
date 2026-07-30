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

Ask it something your document covers, and the answer arrives with the document's name attached. There is a little more to know before putting that tag on a production site — see [On your own site](#on-your-own-site).

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

## How it refuses to make things up

1. **Retrieve** — hybrid search over your documents. Keyword and vector results are fused by rank, so an exact product name or SKU still wins even when its embedding is unremarkable.
2. **Generate** — the model answers in segments, each labelled either a general remark or a claim about your business.
3. **Validate** — every business claim must cite a chunk that retrieval actually returned. A citation the model invented, or a claim with none, is rejected. High-risk topics — price, warranty, stock, refunds — are always treated as claims regardless of how the model labelled them.
4. **Refuse** — if the answer cannot be grounded after one repair round, the assistant declines and records why.

Nothing reaches your customer unvalidated, which is why answers are not streamed token by token: validation runs on the whole answer. What *is* streamed is the stage — "looking through our documents", "writing an answer", "checking it against our documents" — so a few seconds of waiting reads as work rather than as a hang. If the event stream cannot be used, because a proxy buffers it or the server predates the route, the widget falls back to a plain request and the visitor notices nothing.

## Giving it knowledge

Four ways in, all equivalent once the text is chunked: paste it in the panel, pipe it through `add-text`, point at a page with `add-url` or **Knowledge → Read a page from your site**, or point at the whole site with `add-site`.

```bash
node packages/cli/dist/main.mjs add-site my-shop https://myshop.example --max-pages 25
node packages/cli/dist/main.mjs add-site my-shop https://myshop.example/sitemap.xml
```

`add-site` follows the site's own links, stays on its origin, and obeys `robots.txt`. Each page becomes its own source under its own title, because a citation reading "Delivery terms" is worth something to a customer and one reading "My Shop" is not. Give it a sitemap and it reads exactly what the sitemap lists, without following links — the owner already said what they wanted found. Pages it could not read are named with the reason rather than counted, and one unreadable page never ends the crawl: a site with a PDF in its menu is completely ordinary.

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

## When it cannot answer

A refusal is the moment a person needs to take over, so the business hears about it. Choose how in **Settings → Answering**:

- **Record it here** — the default. The question lands under **Escalations** with the reason it could not be answered. Nothing is sent anywhere, which is the honest behaviour for a business that has not said where to send it.
- **Post it to a webhook** — a JSON `POST` with the customer's question, the reason and the channel. One mechanism covers Slack, Discord, n8n, Zapier, a CRM and a two-line script; email would mean SMTP credentials, a queue and bounce handling to reach a place most teams forward to chat anyway.

The notice is sent in the background. A slow relay must not make an unanswerable question slow for the customer who asked it, and a relay that is down is logged for the operator rather than turned into an error the customer sees. The question is in the payload because the reason alone says the assistant could not answer, while the question says what to write.

## Running without AI at all

Set the answer mode to `static` and QuidChat stops calling a model. Questions are matched against **canned answers** — exact text a person wrote — using full-text search plus trigram matching, so different wording and typos still match. It costs nothing to run and cannot invent anything, because there is nothing to invent from.

Add them in **Canned answers** in the admin panel. Every row has a state:

- **Draft** is invisible to matching. It is never sent to a customer.
- **Live** is sent word for word.

The two are separate on purpose. An answer typed into the panel is approved as it is saved, because the person typing it is the review; anything arriving another way — an import, a future AI suggestion — starts as a draft and stays silent until someone approves it. That is what makes `static` safe for price and warranty questions: every answer a customer can receive was read by a person first. Withdrawing is the same one click, because taking a wrong answer down has to be as easy as putting it up.

A `static` tenant with no live answers refuses every question. That is deliberate — the alternative is making one up.

## Cost control

- **A rate limit, not only a budget.** The budget bounds what a tenant spends in total and says nothing about how fast. Two token buckets guard every route — per visitor (10 in a burst, then one every four seconds) and per tenant (60, then two a second) — so a script with a valid slug cannot burn a month of budget in a minute. It is in-memory and therefore per process; the budget guard is the shared backstop, because that one lives in the database.
- **Answer modes.** `full` generates. `thrifty` retrieves and quotes, without generation. `static` answers only from approved canned text and never calls the model at all. Switch modes in **Settings → Answering**; it takes effect on the next question, with no restart and no redeploy.
- **Prompt caching.** The prompt is ordered stable-to-volatile so the cacheable prefix stays byte-identical between questions. Retrieved context goes last, never into the system prompt.
- **A bounded conversation.** The last twenty messages travel with each question, not the whole thread. Without that bound a long conversation grows its own cost with every turn — the tenth question pays for the previous nine — and eventually exceeds the model's context window, failing for a reason no customer could understand. Ten exchanges is far more than a follow-up needs: "how much is that one?" refers to the last thing named.
- **A real spend limit.** `monthly_budget_cents` is enforced *before* the provider is called, and every turn's real token usage is recorded — including refusals, which is where the expensive failures hide.

  What it guarantees precisely: no turn *starts* once recorded spend has reached the limit. Turns already in flight finish, so a tenant answering several questions at the same instant can cross the line by roughly one turn per request in flight — measured at two cents over a twelve-cent limit with eight simultaneous requests. Making it exact would mean holding a lock across every model call, which costs more than it saves; the rate limit is what keeps the overshoot small.

## Channels

The website widget works out of the box. The others are opt-in — absent credentials mean the webhook route returns `404`, because a business that only uses the widget should not have a live unauthenticated WhatsApp endpoint on its server.

Point the platform at `POST /v1/channels/:channel/:tenantSlug`.

Credentials go in **Channels** in the admin panel, or in the environment. Stored credentials win: on one installation serving several businesses, an environment variable is one bot for everyone, and a business that connected its own WhatsApp number has to answer its own customers from it. The environment stays the right choice for a single-tenant install and for a shared bot.

Anything saved in the panel is encrypted with `QUIDCHAT_SECRET_KEY` (`openssl rand -base64 32`) using AES-256-GCM, and the panel never shows a stored value back — not even masked. There is nothing to do with a token except replace it, and a field that displays four characters of one is a field that leaks four characters of one. Without the key set, the panel says so rather than offering a form that cannot work; storing credentials in plain text is not offered as an alternative, because a database backup would then hand over the ability to send messages as the business.

| Channel | Variables |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET_TOKEN` |
| WhatsApp Cloud | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` |
| WAHA (self-hosted WhatsApp) | `WAHA_BASE_URL`, `WAHA_SESSION`, `WAHA_API_KEY` |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` |

**Self-hosted WhatsApp** goes through WAHA, which runs Baileys as its engine and exposes it over HTTP. QuidChat talks to that HTTP API rather than embedding the library: a Baileys session is a long-lived socket with its own pairing, reconnection and auth state, and putting one per tenant inside the process that answers customers makes an outage in an unofficial protocol into an outage of everything. Running it beside QuidChat keeps each failure where it belongs.

Set the signature secret. Verification runs before anything is parsed or stored, so a forged request never reaches the pipeline — without it, anyone who learns the URL can put words in a business's conversation history and spend its budget.

A long answer is split at each platform's own limit — 4096 characters on Telegram and WhatsApp, 2000 on Discord — at a paragraph break where there is one, a sentence break otherwise. Without that a grounded answer with its citations, which passes those limits easily, was rejected by the platform and the customer got nothing at all, after the answer had already been produced, recorded and paid for.

Every channel goes through the identical pipeline. Routing, retrieval, grounding, refusal and spend behave exactly as they do on the website, because the promise the product makes does not change with the transport.

## On your own site

Your site and the QuidChat server are different origins, so every request the widget makes is cross-origin. The public routes — the chat endpoints, the widget config and the bundle itself — answer preflights and echo the requesting origin, which is all a browser needs.

What decides whether a site may actually use your assistant is the per-tenant origin allowlist. It runs on the request itself and answers `403`, and the CORS header is sent on that `403` deliberately: withholding it would hide the refusal and its message from the widget, turning the most common setup mistake into an unexplained one. The admin API has no CORS at all — the panel is served by the same process, so it is already same-origin.

If your site sets a `Content-Security-Policy`, allow the bundle and the API: `script-src https://your-quidchat-host` and `connect-src https://your-quidchat-host`. Nothing is needed for styles. The widget builds its stylesheet through the CSSOM rather than injecting a `<style>` element, so `style-src 'self'` leaves it looking as intended instead of stripping it back to an unstyled button.

On a phone the panel takes the screen the way a messaging app does, rather than sitting in a 320-pixel box in the corner. Most customers arrive on one.

A conversation follows a visitor across your pages. The widget keeps the conversation id in `sessionStorage`, so someone who asks about a product and then walks to checkout is still in the same thread — "how much is that one?" only means something after "do you have it in blue?". Closing the tab ends it, which is both what a person expects and what leaves least behind on their machine. Only the id is stored, never the messages: restoring the visible transcript would mean an endpoint that hands a conversation to anyone holding its id, and that turns the id into a password for someone else's questions.

## Making it look like yours

**Settings → Widget** sets the accent colour, which side the launcher sits on, and the title your customers read. The colour is a colour picker rather than a text field, because the widget only accepts a real colour and a typed value that gets rejected reads as the setting being broken.

The widget reads those over a public endpoint, so it carries presentation only — never the refusal text, the models, the budget or the allowed origins. It validates every value again in the browser before any of it reaches CSS: a value that is not a colour cannot close a style declaration and add rules to your customer's page. A theme that fails to load, for any reason, leaves the widget looking exactly as it does by default.

## Providers

Set one key. QuidChat finds it, tells you what it picked, and refuses to start if nothing usable is configured — rather than failing later on a customer's question.

Every provider call has a deadline and is retried when the provider says "not now". A `429` or a `503` under ordinary load used to become a refusal: the customer's question spent, an escalation recorded that reads as missing content, and the visitor told the assistant could not help — when waiting half a second would have answered them. `Retry-After` is honoured when the provider sends it, capped so nobody is kept waiting on a shop's website for an hour. A bad key, an unknown model or a malformed response is never retried, because it would fail the same way again.

| Provider | Variable | Base URL override |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` |
| xAI (Grok) | `XAI_API_KEY` | `XAI_BASE_URL` |
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

Each service is asked for a model it actually has — `llama-3.3-70b-versatile` on Groq, `deepseek-chat` on DeepSeek, `gpt-4o-mini` on OpenAI — written onto a tenant when it is created and changeable in the panel afterwards. Before this every tenant asked every provider for a Claude model, so most of the services listed above answered `unknown_model` to every question.

When several keys are present the search order above decides, and `QUIDCHAT_CHAT_PROVIDER` / `QUIDCHAT_EMBED_PROVIDER` override it. That matters more than it sounds: Groq and DeepSeek have no embeddings endpoint, so using either means also configuring OpenAI — and OpenAI outranks them, so without an override it would win chat too and the service you chose would never answer anything.

Anthropic has no embeddings endpoint, and retrieval needs one. Set `ANTHROPIC_API_KEY` **and** `OPENAI_API_KEY` and you get chat from Anthropic with embeddings from OpenAI — the pairing most people actually want. QuidChat says so on start-up rather than leaving you to discover it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3210` | `0` asks the OS for a free port |
| `DATABASE_URL` | — | Managed Postgres. Absent means embedded PGlite |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Where PGlite stores data. `memory` for ephemeral |
| `QUIDCHAT_ADMIN_TOKEN` | — | Required by the admin API; unset means admin routes refuse. Compared in constant time, and wrong guesses are rate limited per source |
| `QUIDCHAT_SECRET_KEY` | — | 32 bytes, base64 or hex. Encrypts channel credentials saved in the panel |
| `QUIDCHAT_CHAT_PROVIDER` | — | Which configured service answers. Overrides the search order |
| `QUIDCHAT_EMBED_PROVIDER` | — | Which configured service embeds. Overrides the search order |
| `QUIDCHAT_LOG` | `text` | One line per request. `json` for anything that parses logs, `off` for none |

The panel is served at `/panel` by the same process that serves the API, so an install has an interface without a second deployment. The API keeps `/admin/*`: one namespace for pages and endpoints would make every new route a question about which it is, and the first wrong guess would shadow a working endpoint with an HTML page.

`GET /health` answers `{"status":"ok"}` without touching Postgres — a liveness probe that failed while the database was briefly unreachable would make an orchestrator kill a process that was about to recover, turning a blip into an outage.

## Multi-tenant by construction

One installation, many businesses, and none can see another's data.

Isolation is row-level security, not application filters. Foreign keys carry `tenant_id` as composite keys, because foreign key checks bypass row security — which makes a cross-tenant reference impossible rather than merely forbidden. The migration refuses to apply if any table is left unprotected, and the test suite attacks that guard rather than trusting it.

## Keeping only what you need

`retention_days` deletes conversations once they pass it. The server runs a pass at start-up and once a day after; `quidchat prune` does the same thing once and exits, for anyone who would rather see it in their own crontab.

Only conversations are deleted, and messages, citations and escalations follow by cascade — four separate deletes would be four chances to leave a customer's text behind under another table's name. `usage_events` is kept deliberately: it holds a model name and token counts rather than anything a customer wrote, and the monthly budget is computed from it, so pruning it would quietly hand a tenant more spend than they configured. `0` means keep forever, the same way `monthly_budget_cents = 0` means unlimited.

## Storage

Postgres, at every scale, from one schema and one set of migrations.

- **Trying it out** — embedded PGlite, no install, no Docker.
- **One server** — the same PGlite, on disk.
- **Growing** — point `DATABASE_URL` at managed Postgres. Nothing else changes.

PGlite is real Postgres compiled to WASM, so row-level security, `pgvector` and full-text search behave in tests exactly as they do in production. That matters more than convenience: tenant isolation is only safe if it is genuinely tested, and contributors skip tests that need Docker.

## Stopping and restarting

Every request writes one line — method, status, duration, path — and health checks write none, because a probe arrives every few seconds forever and says nothing about the product. It is on by default: a server whose output is silent looks dead, and its log is the first thing anyone reads when they think a deployment is broken.

QuidChat checks for this at start-up and says so in its output if it finds it, because the alternative is discovering it from a setting that will not stick. It reports and does not repair: deciding what a business's configuration really was is not a choice a start-up routine should make on its own.

Stop it with `SIGTERM`, not `SIGKILL`. On the embedded tier the database lives in the process, and killing it outright can leave the data directory inconsistent in ways Postgres itself would normally prevent — this project has seen a table hold two live versions of a row whose primary key allows one, after a server was killed rather than stopped. The symptom is quiet: reads return one version and writes land on the other, so a setting changed in the panel appears to save and does nothing. The code asserts that invariant wherever it reads a settings row, so the state is reported rather than obeyed, but the cure is a clean shutdown.

`SIGTERM` drains: the server stops accepting connections, finishes the requests it is already answering, and closes the database before exiting. A container runtime sends `SIGTERM` and waits a few seconds before killing the process, so without this a redeploy drops whoever was mid-question and, on the embedded tier, can leave their answer unflushed — answered and then forgotten. A second `SIGTERM` exits immediately, because someone sending it twice wants out now rather than a process that looks hung.

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

`pnpm smoke` runs the built binary the way a person does: it creates a tenant, indexes a document, starts the server, asks a question and checks the answer cites the document by name, then shuts it down with `SIGTERM`. It talks to a local OpenAI-compatible stub, so it needs no key and no network — and it exercises `OPENAI_BASE_URL` along the way. Run it after `pnpm build`.

When a browser is available it goes further, against the same server: it uses the admin panel's forms the way an owner does, and it serves a page from its own origin with nothing on it but the embed snippet and walks through the customer's journey — open the widget, ask, read the answer and its citation. Both halves skip themselves with a message if there is no browser; set `CHROME_PATH` to point at yours.

Every defect it checks for was invisible to the unit suite and obvious within a minute of using the thing: a `bin` pointing at a TypeScript file, migrations resolved relative to a module that no longer existed once bundled, a data directory whose parent was never created, and `add-text` printing its success line and then never exiting. Behaviour is what the suite covers; this covers the artifact.

Both browser halves can also be run on their own, against a server you already have going: `pnpm widget:check <api-url> <tenant-slug>` and `pnpm panel:check <api-url> <admin-token>`. The widget one serves its page from a separate origin on purpose — the server once shipped without CORS headers, so the widget worked from curl, from the test suite, and from no browser at all, and a check that never leaves the same origin cannot see that. Add `http://127.0.0.1:4901` to the tenant's allowed origins first; the script says so if you have not.

After changing anything under `packages/db/migrations/`, run `pnpm generate:migrations`. The SQL is embedded in a module so applying migrations never depends on a filesystem path — a path relative to the module works only from the source tree, and a bundled binary dies on start instead. A test fails if the two copies drift.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It is short, and the half of it worth reading is the list of things about this codebase that will surprise you — starting with the fact that using the database handle directly on a tenant-scoped table returns every tenant's rows.

## Licence

MIT.
