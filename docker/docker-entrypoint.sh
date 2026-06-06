#!/bin/sh
# Container entrypoint. Runs as root (PID1 via tini) so it can chown the
# root-mounted Railway volume, then drops to the unprivileged `node` user via
# gosu for ALL application code (bootstrap + server).
set -eu

# Railway injects $PORT at runtime; the server reads MCP_PORT. Bridge them.
# Falls back to the in-code default (3020) if neither is set.
export MCP_PORT="${MCP_PORT:-${PORT:-3020}}"
export MCP_TRANSPORT=http

# State dir resolves from HOME (os.homedir()); HOME=/home/node is set in the image
# and preserved by gosu, so root-here and node-later agree on the same path.
STATE_DIR="${HOME:-/home/node}/.consciousness-protocol"
mkdir -p "$STATE_DIR/keys"

# Railway mounts volumes owned by root. Hand the whole state dir to `node` so every
# config/key/chain file is created and read by the unprivileged user. Best-effort:
# on a fresh image (no volume) the dir is already node-owned.
chown -R node:node "$STATE_DIR" 2>/dev/null || true

# Provision config + wallet keys from env (no-op when no secrets are present).
gosu node node /app/docker/bootstrap.mjs

# Hand off to the MCP server as `node`. exec keeps it as tini's direct child so
# SIGTERM (Railway redeploy/stop) is delivered straight to the process.
exec gosu node node /app/dist/index.js --http
