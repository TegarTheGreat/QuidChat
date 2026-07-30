# syntax=docker/dockerfile:1

# Pinned to the exact floor in package.json's "engines.node" (>=22.22.3), not a floating
# "22-slim" tag, so a base-image update can never silently drop below the version this
# codebase was tested against.
ARG NODE_VERSION=22.22.3

# ---------------------------------------------------------------------------
# Build stage: full workspace install (dev dependencies included, tsdown needs
# them to bundle each package's TypeScript source) and the production build.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build

# corepack ships with Node but starts disabled; pinning the exact version from
# "packageManager" keeps the build reproducible instead of trusting whatever pnpm
# corepack would otherwise fetch as "latest".
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

WORKDIR /app

# Manifests first, source after: this layer only invalidates when a dependency
# actually changes, so an ordinary code change doesn't force a full reinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/admin/package.json packages/admin/
COPY packages/channels/package.json packages/channels/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ingest/package.json packages/ingest/
COPY packages/providers/package.json packages/providers/
COPY packages/server/package.json packages/server/
COPY packages/widget/package.json packages/widget/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# `@quidchat/cli`'s dist bundle is self-contained for every OTHER workspace package
# (tsdown inlines `@quidchat/core`, `@quidchat/db`, `@quidchat/server`, `@quidchat/providers`
# and `@quidchat/ingest` straight into dist/main.mjs — they're only devDependencies of
# @quidchat/cli precisely because nothing at runtime needs them as separate modules).
# What main.mjs does still need at runtime are the handful of packages tsdown leaves
# external (pglite, its pgvector extension, drizzle-orm, postgres). `pnpm deploy --prod`
# resolves exactly that set into a throwaway node_modules, without devDependencies along
# for the ride. `--legacy` is required here: pnpm 10+ otherwise refuses to deploy a
# workspace that isn't using injected dependencies, which this one deliberately isn't.
RUN pnpm --filter=@quidchat/cli deploy --prod --legacy /tmp/deploy

# ---------------------------------------------------------------------------
# Runtime stage: only the built widget/cli bundles plus their runtime node_modules.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

WORKDIR /app

# The base image has no unprivileged user by default; running as root inside a
# container that talks to a database and the open internet is an avoidable blast
# radius, so one is created explicitly rather than relying on an image that may or
# may not already have one.
RUN groupadd --system --gid 1001 quidchat \
    && useradd --system --uid 1001 --gid quidchat --home-dir /app quidchat

# node_modules holds the runtime-external dependencies resolved by `pnpm deploy`
# above; Node's module resolution walks up from packages/cli/dist looking for a
# node_modules directory, so one at the app root is enough — it does not need to
# sit next to the file that imports it.
COPY --from=build /tmp/deploy/node_modules ./node_modules

# The CLI's bundle stays at its real workspace path, not flattened to /app/dist,
# because `handleWidgetAsset` locates the widget bundle with
# `new URL("../../widget/dist/index.iife.js", import.meta.url)` — a path relative to
# wherever main.mjs itself ends up. Preserving packages/cli and packages/widget as
# siblings under packages/ is what keeps that resolution correct instead of 503ing on
# every request for /quidchat.js.
COPY --from=build /app/packages/cli/dist/main.mjs ./packages/cli/dist/main.mjs
COPY --from=build /app/packages/widget/dist/index.iife.js ./packages/widget/dist/index.iife.js

# The PGlite tier writes here by default (QUIDCHAT_DATA_DIR defaults to
# ./.quidchat/data). Creating and chowning it before the VOLUME declaration matters:
# Docker seeds a fresh named volume from whatever is already in the image at that
# path, so an unprivileged process only gets write access on first run if the
# directory already belongs to it here.
RUN mkdir -p /app/.quidchat/data && chown -R quidchat:quidchat /app

USER quidchat

ENV NODE_ENV=production

EXPOSE 3210

VOLUME ["/app/.quidchat/data"]

# GET /health deliberately never touches Postgres (see server.ts), so a database that
# is merely slow to accept connections never gets misread as "the process is dead" —
# curl/wget aren't in the slim image, but Node's own fetch is, so the check needs
# nothing extra installed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "packages/cli/dist/main.mjs", "serve"]
