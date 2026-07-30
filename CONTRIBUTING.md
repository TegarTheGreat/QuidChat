# Contributing

Thanks for looking. This file is short on ceremony and long on the two or three things about this codebase that are genuinely surprising.

## Getting set up

```bash
pnpm install
pnpm build
pnpm test
```

No Docker, no database to install: the tests run Postgres compiled to WebAssembly. That is deliberate — tenant isolation here is enforced by row-level security, and row-level security is only safe if it is genuinely tested, so the tests had to be something a contributor would actually run.

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` is the one people skip and the one that keeps catching things. It runs the built binary the way a person does — creates a tenant, indexes a document, starts the server, asks a question, checks the citation, shuts down on `SIGTERM` — and, if you have Chrome or Chromium, uses the admin panel's forms and walks a customer through the widget from a separate origin.

Every artifact-level defect this project has had was invisible to the unit suite and obvious within a minute of using the thing: a `bin` pointing at a TypeScript file, migrations resolved relative to a module that stopped existing once bundled, a command that finished its work and never exited, a widget that could not talk to its own server from a browser. Behaviour is what the suite covers. The artifact is what `pnpm smoke` covers.

## Things that will surprise you

**Tenant isolation is row-level security, not a `WHERE` clause.** Every read and write to a tenant-scoped table goes through `withTenant`. Using the raw database handle on such a table returns *every* tenant's rows — not zero, not an error. That is intentional and it is why three things use the raw handle deliberately: migrations, creating a tenant, and the retention pass.

**Foreign keys carry `tenant_id`.** They are composite on purpose: a foreign key check bypasses row security, so a plain reference to another table's `id` would let one tenant point at another's row. The migration refuses to apply if any table is left unprotected, and the tests attack that guard rather than trusting it.

**Answers are not streamed token by token, and should not be.** Grounding validation runs on the complete answer. Streaming raw tokens would put an unvalidated claim in front of a customer, which is the one failure this product exists to prevent. What streams is the *stage* — retrieving, generating, validating.

**A refusal is a success.** `200`, not an error. The assistant declining to invent an answer is the product working. Code and tests that treat it as a failure are wrong.

**The panel's API client is typed against the wire, and the types have lied before.** Six field-name and wrapper-shape mismatches once shipped because nothing ran the client against the server — a mocked client agrees with whatever the client believes. `packages/server/src/admin-contract.test.ts` runs the real client module against the real HTTP server. If you add a route the panel calls, add it there.

**After editing anything under `packages/db/migrations/`, run `pnpm generate:migrations`.** The SQL is embedded in a module because a path relative to the source tree does not survive bundling. A test fails if the two copies drift, and CI leaves the regenerated file in the diff for you.

## Writing code here

Match the surrounding style; there is a consistent one. In particular, comments explain **why**, never what. A comment that restates the line above it is noise; a comment that records why a value is 10 rather than 60, or why a check runs before the one below it, is why the next person does not undo your work.

Product copy is written for the person reading it. The message a shop's customer sees does not name QuidChat — they have never heard of it. The message the person who pasted the script tag sees does, because naming it is what makes that message actionable.

Everything in the codebase is in professional English: identifiers, comments, tests, error messages, column names. The only exception is product copy a business writes for its own customers, which is theirs to write in whatever language they serve.

## Adding a channel

One entry in `packages/channels/src/registry.ts` — id, title, hint, credential fields with their labels and environment variable names, and a factory — plus a line in a migration widening the `channel_configs` CHECK constraint.

Nothing else. The server reads credentials from the environment and from a tenant's stored secrets using the same definition, the admin API serves the field list from it, and the panel renders whatever the API says. It was six places before, five of which were the same information written five ways, with nothing to notice when they disagreed.

## The one tool the model may call

`handoff(to, reason)` — a skill passing a question to the sibling that owns it. Two properties are load-bearing and easy to undo by accident:

**The target is an enum built from the database**, so an invented skill is not representable. **The tool list is identical for every skill in a tenant** — tools render *before* the system prompt, so a list that varies per skill moves the first cache breakpoint to position 0 and re-bills the entire prefix on every handoff. Which targets a skill may actually reach is enforced in code after the call, not by changing what the model sees.

`Provider` is a public interface — a self-hosted deployment can supply its own. Read new fields defensively; a provider written before `toolCalls` existed once took down every turn with a `TypeError` the customer saw as a refusal.

## The widget is somebody else's page

Three constraints follow from that, and each has already been learned the hard way:

**No web font.** Pulling a typeface in costs the host page a render-blocking request and a layout shift for the sake of our branding. Personality comes from scale, weight and tracking on a system stack.

**The bundle URL never changes.** The embed is a fixed `<script src=".../quidchat.js">`, so caching must revalidate. It was once served `immutable, max-age=31536000` on the reasoning that a deploy replaces the file — but a browser caches by URL, so every site that had ever loaded the widget kept a year-old copy and would never receive a fix.

**Chrome follows the answers.** Button labels and the placeholder come from `theme.locale`. English chrome around an Indonesian answer is one assistant addressing a customer in two languages.

The source chip is the signature, and it is deliberately not the tenant's accent colour: a citation is QuidChat's guarantee that the sentence came from the business's own document, not the shop's decoration.

## Opening questions come from data that already exists

A blank message log is why widgets go unused: a visitor has to invent a question and guess whether the thing can answer it. The opening screen defaults its suggestions to the tenant's **approved** canned answers — questions the business already knows it gets, and that are guaranteed answerable, so a shop that has done that setup gets openers for free. `widget_theme.starters` overrides them.

Only approved ones, ever. A draft is text nobody has agreed to show a customer; on the opening screen it would be shown to every one of them.

## The setup assistant is the mirror image of the customer one

The customer-facing assistant answers strangers about a business, so every claim about that business must carry a citation. The setup assistant answers the owner about their own QuidChat, so it needs to explain, suggest and disagree — the grounding validator is **deliberately not run on it**.

What replaces that safeguard is the confirmation gate. Four actions stop and wait for a person: approving canned answers, deleting a knowledge source, changing the embedding model, and setting a provider credential. Everything else runs immediately.

**The gate is enforced twice, and both are load-bearing.** `runSetupTurn` hands a gated call back instead of executing it — and holds back the rest of the batch, so a re-index cannot run while the owner is still deciding about the deletion beside it. `POST /admin/setup/chat` then refuses the same call again unless `confirmed: true`. A gate enforced only where the model runs is bypassed by anything that can reach the endpoint, and that endpoint takes an admin token — exactly the credential an owner pastes into other tools.

Don't gate a reversible action. It trains an owner to click Allow without reading, which is how the gate stops protecting the four that matter.

## Commits

Present tense, and say why rather than what. The diff already says what.
