# Draft: HTTP/Hosted Mode + Env Reference
<!-- proposed additions to README.md — ready to paste -->
<!-- status: draft -->

---

## HTTP / Hosted Mode

stdio is the default. Use HTTP transport when you're running the server remotely, sharing it across multiple agents, or deploying to a hosted environment.

### Start in HTTP mode

```bash
# Flag
node dist/index.js --http

# Environment variable
MCP_TRANSPORT=http node dist/index.js

# Custom port (default: 3020)
MCP_PORT=8080 MCP_TRANSPORT=http node dist/index.js
```

The server binds at `http://localhost:{PORT}/mcp`.

### Connect from Claude Code

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "consciousness-protocol": {
      "url": "http://your-host:3020/mcp"
    }
  }
}
```

Via CLI:

```bash
claude mcp add consciousness-protocol --transport http http://your-host:3020/mcp
```

### Session lifecycle

Each new client gets a unique session ID assigned by the server. The server runs a separate MCP instance per session — tool registrations and state are isolated. Close a session with:

```
DELETE /mcp
mcp-session-id: <id>
```

Sessions close on disconnect.

### Production deployment

Run behind a reverse proxy for TLS:

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3020;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
}
```

The server has no built-in auth. Put authentication at the proxy layer.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `MCP_PORT` | `3020` | HTTP listen port |
| `VOLEM_API_URL` | `http://localhost:3010` | Volem API base URL (fallback; `volemApiUrl` in config.json takes precedence) |

---

## config.json Reference

`~/.consciousness-protocol/config.json` — created by `setup`. Edit directly or re-run `setup`.

```json
{
  "network": "testnet",
  "near": {
    "accountId": "my-agent.testnet",
    "registryContract": "consciousness-protocol.testnet"
  },
  "story": {
    "evmAddress": "0x...",
    "rpcUrl": "https://aeneid.storyrpc.io",
    "chainId": "aeneid",
    "spgNftContract": "0x..."
  },
  "ipfs": {
    "pinataJwt": "eyJ...",
    "pinataKeys": ["eyJ...", "eyJ..."],
    "gateway": "https://gateway.pinata.cloud"
  },
  "backend": "volem",
  "volemApiUrl": "http://localhost:3005",
  "storyApiKey": "sk-..."
}
```

| Field | Required | Description |
|---|---|---|
| `network` | yes | `testnet` or `mainnet` |
| `near.accountId` | yes | NEAR account ID |
| `near.registryContract` | yes | Registry contract address |
| `story.evmAddress` | yes | EVM wallet address |
| `story.rpcUrl` | yes | Story Protocol JSON-RPC URL |
| `story.chainId` | yes | `aeneid` (testnet) or `mainnet` |
| `story.spgNftContract` | no | SPG NFT collection — created on first `register_work` |
| `ipfs.pinataJwt` | no | Pinata JWT key |
| `ipfs.pinataKeys` | no | Multiple Pinata JWT keys, rotated on 403 / rate limit |
| `ipfs.gateway` | no | IPFS gateway (default: `gateway.pinata.cloud`) |
| `backend` | no | Search/showcase backend: `volem` (default), `story`, `local` |
| `volemApiUrl` | no | Volem API URL — also readable from `VOLEM_API_URL` env var |
| `storyApiKey` | no | Story Protocol API key — required for `backend=story` |
