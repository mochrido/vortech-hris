# syntax=docker/dockerfile:1

# Multi-stage build producing a small, non-root production image.
# The app is built with Next.js `output: "standalone"` (see next.config.ts),
# so the runner stage copies only the self-contained server bundle + static
# assets — not the full node_modules tree.

# ---- deps: install production dependencies for the standalone trace ----
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the Next.js standalone output ----
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal non-root production image ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone server binds via server.js. Copy the traced server bundle,
# static assets, and any public files. node:22-alpine already ships an
# unprivileged `node` user (uid/gid 1000).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# The `jobs` compose service runs maintenance scripts (auto-checkout,
# migrations) straight off the repo with the same traced node_modules as the
# server bundle; ship the script, migration, and shared-lib trees.
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/src/lib ./src/lib

# Guarantee the destination exists even if the source repo has an empty or
# absent public/ (a bare `COPY /app/public ./public` fails the BuildKit build
# when the source directory is missing). public/.gitkeep keeps the dir tracked.
RUN mkdir -p ./public
COPY --from=build --chown=node:node /app/public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
