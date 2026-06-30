# syntax=docker/dockerfile:1
#
# Client/self-custody MCP image for consciousness-protocol-mcp.
# This image is for agents that intentionally self-host their signer/local-state
# MCP. Volem-hosted read-only MCP is built from the Volem repo's `mcp` target,
# not from this client package.
#
# Multi-stage:
#   builder -> full deps + `tsc` -> dist/
#   deps    -> production-only node_modules
#   runtime -> slim image, tini (PID1) + gosu (privilege drop), non-root `node`
#
# Base image: node:22-bookworm-slim (Debian/glibc), NOT alpine.
# Rationale: the dependency tree has zero native add-ons today (`@noble/*` is
# pure-JS crypto; verified: 0 *.node, 0 binding.gyp), so alpine would build —
# but slim removes musl/getaddrinfo risk for the heavy @story-protocol/core-sdk
# tree at a ~40MB cost that does not matter here, and ships a shell + gosu for
# the privilege-drop entrypoint.

# ---- builder: full deps, compile TypeScript -> dist/ ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
# Lockfile-only layer: re-runs `yarn install` only when deps change, not on src edits.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# ---- deps: production-only node_modules (no tsc/tsx/@types) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    MCP_TRANSPORT=http
# tini  = correct PID1 (forwards SIGTERM from Railway redeploys, reaps zombies).
# gosu  = drop root -> node AFTER the entrypoint has chowned the root-mounted volume.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY docker/bootstrap.mjs ./docker/bootstrap.mjs
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /home/node/.consciousness-protocol/keys \
    && chown -R node:node /home/node

# IMPORTANT: no `USER node` here. The container starts as root so the entrypoint
# can chown the Railway volume (Railway mounts volumes owned by root). The
# entrypoint immediately drops to the unprivileged `node` user via gosu before
# running ANY application/bootstrap code — wallet keys are never handled by root.
ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
