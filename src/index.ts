#!/usr/bin/env node
/**
 * Consciousness Protocol MCP Server
 *
 * Provides AI agents with tools for:
 * - Hash chain management (create, add state, verify, export)
 * - NEAR blockchain (publish state, get agent info)
 * - Story Protocol IP (register work, derivatives, licensing, royalties)
 * - Provenance verification (cross-chain verification)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TokenBucketRateLimiter, clientKeyFromForwarded } from './rate-limit.js';
import { createLogger } from './logger.js';

import { registerWorkTool } from './tools/register-work.js';
import { nearTools } from './tools/near.js';
import { chainTools } from './tools/chain.js';
import { verifyProvenanceTool } from './tools/verify.js';
import { searchTool } from './tools/search.js';
import { loadConfig, type Config } from './config/store.js';

// Load config (or return null if not set up yet)
let config: Config | null = null;
try {
  config = loadConfig();
} catch {
  // Not configured yet — setup tool will handle this
}

/**
 * Build a fully-configured MCP server instance with all tools registered.
 *
 * IMPORTANT: each MCP `Server`/`Protocol` instance can be connected to exactly
 * one transport (the SDK's `Protocol.connect` throws "Already connected to a
 * transport" on a second connect). In HTTP mode we therefore create a fresh
 * server per session instead of sharing one singleton across requests.
 *
 * `allowInstallSkill` gates the `install_skill` tool. It installs to the host's
 * `~/.claude/skills/` and may auto-mint a license from the host wallet — both
 * are meaningful only for a local (stdio) caller. On a hosted HTTP server the
 * filesystem and wallet are the SERVER's, so a remote caller triggering an
 * install writes to the host and spends the host's funds. HTTP callers pass
 * `false`; stdio passes `true`.
 */
function buildServer({ allowInstallSkill }: { allowInstallSkill: boolean }): McpServer {
  const server = new McpServer({
    name: 'consciousness-protocol',
    version: '0.1.0',
  });

  // ─── Setup Tool ───

  server.tool(
  'setup',
  'Initialize the protocol: create or import NEAR account, EVM wallet, and IPFS config. Run this first.',
  {
    agent_name: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/, 'Lowercase alphanumeric, hyphens, underscores only').describe('Agent name for NEAR account (e.g. "chiti")'),
    network: z.enum(['testnet', 'mainnet']).default('testnet').describe('NEAR/Story network'),
    near_account: z.string().optional().describe('Existing NEAR account ID (skip creation)'),
    near_private_key: z.string().optional().describe('Existing NEAR private key'),
    evm_private_key: z.string().optional().describe('Existing EVM private key for Story Protocol'),
    pinata_jwt: z.string().optional().describe('Pinata JWT for IPFS uploads (optional, free fallback available)'),
  },
  async (params) => {
    const { setupAgent } = await import('./tools/setup.js');
    const result = await setupAgent(params);
    config = loadConfig(); // reload after setup
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Chain Tools ───

server.tool(
  'create_chain',
  'Create a new hash chain for this agent. Each state is SHA-256 linked to the previous.',
  { identity: z.string().describe('Chain identity (e.g. "my-agent")') },
  async (params) => {
    const result = chainTools.createChain(params.identity);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'add_chain_state',
  'Add a new state to the hash chain. Automatically hashed and linked to previous state.',
  {
    type: z.enum(['delta', 'note']).describe('State type: delta (change) or note (observation)'),
    content: z.string().min(1).describe('Content to record'),
  },
  async (params) => {
    const result = chainTools.addState(params.type, params.content);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'verify_chain',
  'Verify the integrity of the local hash chain. Checks all hashes and prev_hash linkage.',
  {},
  async () => {
    const result = chainTools.verify();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'export_chain',
  'Export a chain snapshot for cross-agent audit. Returns last N states with verification instructions.',
  { last_n: z.number().default(20).describe('Number of recent states to export') },
  async (params) => {
    const result = chainTools.exportSnapshot(params.last_n);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── NEAR Tools ───

server.tool(
  'publish_state',
  'Publish current chain head hash to NEAR blockchain. Contract verifies prev_hash (fork detection). Gas: ~$0.003.',
  {
    sequence: z.number().describe('Chain state sequence number'),
    hash: z.string().describe('SHA-256 hex hash of current state'),
    prev_hash: z.string().describe('SHA-256 hex hash of previous state'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await nearTools.publishState(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_agent',
  'Get agent info from NEAR registry (identity, model, trust score, last published state). Free view call.',
  { agent_id: z.string().describe('NEAR account ID of the agent') },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await nearTools.getAgent(config, params.agent_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── IP Tools ───

server.tool(
  'register_work',
  'Register a creative work as IP on Story Protocol with blockchain provenance. Uploads to IPFS, mints NFT, attaches license. ASK PERMISSION: costs gas (~$0.15).',
  {
    title: z.string().describe('Title of the work'),
    content: z.string().optional().describe('Text content of the work (for text-based works)'),
    file_path: z.string().optional().describe('Path to file — image, audio, video, code, etc.'),
    media_type: z.string().optional().describe('MIME type override (e.g. "image/png", "audio/mp3"). Auto-detected from file extension if omitted.'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']).describe('Type of work'),
    ip_category: z.string().optional().describe('IP category: literary-work, invention, ai-model, software, mcp-server, hypothesis, etc. See Volem category list.'),
    url: z.string().optional().describe('External URL: GitHub repo, npm package, website'),
    license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).default('commercial-remix').describe('License type'),
    revenue_share: z.number().min(0).max(100).default(5).describe('Revenue share % for derivatives (default: 5)'),
    minting_fee: z.string().default('0').describe('Price to mint a license in IP tokens (e.g. "0.01"). Default: free.'),
    chain_sequence: z.number().int().min(0).optional().describe('Chain state sequence (for provenance)'),
    chain_hash: z.string().optional().describe('Chain state hash (for provenance)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await registerWorkTool.register(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'register_derivative',
  'Register a derivative work of an existing IP. Only parent_ip_id is required — license terms are auto-resolved and token auto-minted. Revenue share automatically flows to parent. ASK PERMISSION: costs gas + possible minting fee.',
  {
    title: z.string().describe('Title of derivative work'),
    content: z.string().describe('Full text content'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'other']).describe('Type'),
    parent_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address (0x + 40 hex chars)').describe('IP Asset ID of parent work (0x...)'),
    parent_license_terms_id: z.string().optional().describe('License terms ID (auto-resolved if omitted)'),
    license_token_id: z.string().optional().describe('License token ID (auto-minted if omitted)'),
    revenue_share: z.number().min(0).max(100).default(5).describe('Revenue share % for sub-derivatives (default: 5)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await registerWorkTool.registerDerivative(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mint_license',
  'Mint a license token for an IP Asset. Gives right to use the work or create derivatives. ASK PERMISSION: may have minting fee.',
  {
    ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to license (0x...)'),
    license_terms_id: z.string().describe('License terms ID'),
    amount: z.number().default(1).describe('Number of license tokens to mint'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { licenseTool } = await import('./tools/license.js');
    const result = await licenseTool.mint(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_revenue_all',
  'Get revenue summary across ALL your registered IP assets — total earned, total claimable, per-asset breakdown with minting fees and revenue share from derivatives at any depth. Read-only, no gas cost.',
  {},
  async () => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.getRevenueAll(config);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_revenue',
  'Check revenue for ONE specific IP asset — detailed breakdown with minting fees, revenue share from derivatives at any depth, claimable amount. Use get_revenue_all for portfolio overview. Read-only, no gas cost.',
  {
    ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to check (0x...)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.getRevenue(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'pay_royalty',
  'Pay royalty to an IP Asset. Auto-wraps native IP to WIP. ASK PERMISSION: sends money.',
  {
    receiver_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset to pay (0x...)'),
    amount: z.string().describe('Amount in IP tokens (e.g. "0.01")'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.pay(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'claim_revenue',
  'Claim all unclaimed revenue from your IP assets and transfer to your wallet in one step. SDK auto-transfers claimed tokens from IP account to wallet and unwraps WIP to IP. No separate withdraw needed.',
  {
    ip_id: z.string().optional().describe('Specific IP to claim from (default: all own IPs)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.claim(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'verify_provenance',
  'Verify provenance of any IP Asset. Checks Story Protocol metadata → NEAR state → chain integrity. Free, read-only.',
  { ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to verify (0x...)') },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await verifyProvenanceTool.verify(config, params.ip_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Search & Browse Tools ───

server.tool(
  'search_works',
  'Search registered IP assets. Without parameters: lists own works. With query: semantic search. With creator: by address. Backend: volem (default), story (direct API), local. Free, read-only.',
  {
    query: z.string().optional().describe('Search query (semantic search across all assets)'),
    creator: z.string().optional().describe('EVM address of creator to search for'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']).optional().describe('Filter by work type'),
    license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).optional().describe('Filter by license type'),
    limit: z.number().default(20).describe('Max results (default: 20)'),
  },
  async (params) => {
    if (!config && (params.query || params.creator)) {
      return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    }
    const result = config
      ? await searchTool.search(config, params)
      : searchTool.listOwn({ type: params.type, license: params.license });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_asset',
  'Get detailed info about a specific IP asset: metadata, license, provenance, IPFS content. Free, read-only.',
  {
    ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to inspect (0x...)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await searchTool.getAssetDetails(config, params.ip_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Install Skill Tool ───
// Local (stdio) only — see buildServer doc comment. Skipped on hosted HTTP so a
// remote caller cannot write to the host filesystem or spend the host wallet.

  if (allowInstallSkill) {
    server.tool(
      'install_skill',
      'Install a skill/MCP/workflow from the marketplace. Discovers asset → checks license (auto-mints if needed) → downloads (git clone or IPFS) → installs to ~/.claude/skills/. Complete marketplace cycle in one call.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to install (0x...)'),
        install_path: z.string().optional().describe('Custom install path (default: ~/.claude/skills/{name})'),
        auto_license: z.boolean().default(true).describe('Automatically mint license if required (default: true). Set false to skip.'),
      },
      async (params) => {
        if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
        const { installSkillTool } = await import('./tools/install-skill.js');
        const result = await installSkillTool.install(config, params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  return server;
}

// ─── Start Server ───

const useHttp = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

async function main() {
  if (useHttp) {
    const { createServer } = await import('node:http');
    const { randomUUID, timingSafeEqual } = await import('node:crypto');

    // Structured logger for the HTTP transport path. Writes JSON-lines to
    // stderr. The `base` field tags every record so log consumers can filter
    // to this transport without inspecting the message text.
    const log = createLogger({ base: { transport: 'http' } });

    const PORT = parseInt(process.env.MCP_PORT ?? '3020', 10);

    // ── Rate limiting ──────────────────────────────────────────────────────
    // Read configuration from environment with safe fallbacks.
    const rateLimitDisabled =
      process.env.MCP_RATE_LIMIT_DISABLED === '1' ||
      process.env.MCP_RATE_LIMIT_DISABLED === 'true';

    const rateLimitCapacity = (() => {
      const v = parseInt(process.env.MCP_RATE_LIMIT_CAPACITY ?? '', 10);
      return isNaN(v) ? 120 : v;
    })();

    const rateLimitRefillPerSec = (() => {
      const v = parseFloat(process.env.MCP_RATE_LIMIT_REFILL_PER_SEC ?? '');
      return isNaN(v) ? 2 : v;
    })();

    const limiter = rateLimitDisabled
      ? null
      : new TokenBucketRateLimiter({
          capacity: rateLimitCapacity,
          refillPerSec: rateLimitRefillPerSec,
        });

    // ── API-key auth ───────────────────────────────────────────────────────
    // When MCP_API_KEY is set, every /mcp request must present a matching key
    // via either `Authorization: Bearer <key>` or `X-API-Key: <key>`. When it
    // is unset/empty, auth is disabled to preserve local-dev behaviour. The
    // check runs after rate limiting so an unauthenticated flood is throttled
    // before it can probe the key, and after the health probes so they stay
    // reachable without a key.
    const apiKey = process.env.MCP_API_KEY ?? '';
    const authEnabled = apiKey.length > 0;
    const apiKeyBuf = Buffer.from(apiKey);

    // Constant-time comparison. timingSafeEqual throws on unequal lengths, so
    // guard the length first (a length mismatch is already a non-match).
    const keyMatches = (presented: string | undefined): boolean => {
      if (!presented) return false;
      const presentedBuf = Buffer.from(presented);
      if (presentedBuf.length !== apiKeyBuf.length) return false;
      return timingSafeEqual(presentedBuf, apiKeyBuf);
    };

    const extractKey = (req: import('node:http').IncomingMessage): string | undefined => {
      const authHeader = req.headers['authorization'];
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice('Bearer '.length).trim();
      }
      const xApiKey = req.headers['x-api-key'];
      if (typeof xApiKey === 'string') return xApiKey.trim();
      if (Array.isArray(xApiKey) && xApiKey.length > 0) return xApiKey[0].trim();
      return undefined;
    };

    // Map of session ID → transport instance
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = createServer(async (req, res) => {
      // Defense-in-depth: this listener is async, so any rejection it leaks
      // becomes an unhandled promise rejection that terminates the process
      // (exit code 1). Wrap the whole body and answer with a 500 instead of
      // letting the server die when the transport (or server.connect) throws.
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

        // ── Health / readiness probes (no auth, no rate-limit, no session) ──
        // These run before every other check so orchestrators (k8s, docker) can
        // poll them freely without consuming rate-limit tokens or requiring an
        // MCP session. No logging here — these are called frequently.
        if (url.pathname === '/health' || url.pathname === '/ready') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET, HEAD' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let status: number;
          let body: string;

          if (url.pathname === '/health') {
            status = 200;
            body = JSON.stringify({ status: 'ok' });
          } else {
            // /ready: 503 while draining, 200 otherwise
            if (shuttingDown) {
              status = 503;
              body = JSON.stringify({ status: 'shutting_down' });
            } else {
              status = 200;
              body = JSON.stringify({ status: 'ready' });
            }
          }

          res.writeHead(status, { 'Content-Type': 'application/json' });
          // HEAD: send headers only, no body
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }

        if (url.pathname !== '/mcp') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }));
          return;
        }

        // ── Per-IP rate limiting ───────────────────────────────────────────
        // SECURITY: default to the socket address as the client key. Do NOT
        // trust X-Forwarded-For unless MCP_TRUST_PROXY=1 is explicitly set — it
        // is client-controlled and trivially spoofable. When a single trusted
        // proxy IS declared, clientKeyFromForwarded reads the rightmost (proxy-
        // appended) hop, never the client-supplied leftmost ones, so an
        // attacker cannot rotate the key to bypass the limit. See its docstring.
        if (limiter !== null) {
          const clientKey = clientKeyFromForwarded(
            req.headers['x-forwarded-for'],
            req.socket.remoteAddress,
            process.env.MCP_TRUST_PROXY === '1',
          );

          const { allowed, retryAfterSec } = limiter.tryRemove(clientKey);
          if (!allowed) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfterSec),
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Rate limit exceeded' },
                id: null,
              }),
            );
            return;
          }
        }

        // ── Authenticate (covers GET/POST/DELETE on /mcp) ──────────────────
        // Runs after rate limiting and after the health probes above.
        if (authEnabled && !keyMatches(extractKey(req))) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        // Handle DELETE for session cleanup
        if (req.method === 'DELETE') {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          if (sessionId && sessions.has(sessionId)) {
            const transport = sessions.get(sessionId)!;
            await transport.close();
            sessions.delete(sessionId);
            res.writeHead(200);
            res.end();
          } else {
            res.writeHead(404);
            res.end();
          }
          return;
        }

        // For GET/POST: route to existing session or create new one
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        // New session: create a transport AND a fresh server instance.
        // Each MCP server can be connected to exactly one transport, so a
        // shared singleton would throw "Already connected to a transport" on
        // the second session. Build one server per session.
        //
        // The transport's sessionId is assigned only while it processes the
        // initialize message inside handleRequest(), NOT during connect(). We
        // therefore register the session from the onsessioninitialized callback,
        // which the SDK fires exactly when the sessionId is assigned. Reading
        // transport.sessionId before handleRequest() would always be undefined,
        // leaving the sessions map empty and breaking session reuse.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const sessionServer = buildServer({ allowInstallSkill: false });
        await sessionServer.connect(transport);

        await transport.handleRequest(req, res);
      } catch (err) {
        log.error('HTTP request handler error', { err });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    });

    if (limiter !== null) {
      const sweepTimer = setInterval(() => limiter.sweep(), 60_000);
      sweepTimer.unref();
      httpServer.on('close', () => clearInterval(sweepTimer));
    }

    httpServer.listen(PORT, () => {
      log.info(`MCP server listening on http://localhost:${PORT}/mcp`, { port: PORT, mode: 'streamable-http' });
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────
    // Parse shutdown timeout from env using the same safe pattern as rateLimitCapacity above.
    const SHUTDOWN_TIMEOUT_MS = (() => {
      const v = parseInt(process.env.MCP_SHUTDOWN_TIMEOUT_MS ?? '', 10);
      return isNaN(v) ? 10_000 : v;
    })();

    let shuttingDown = false;

    const shutdown = (signal: string): void => {
      if (shuttingDown) {
        // Second signal while drain is in progress — force exit immediately.
        log.warn('Received signal again during shutdown — forcing exit', { signal });
        process.exit(1);
      }
      shuttingDown = true;
      log.info('Received signal, shutting down gracefully', { signal });

      // Backstop: if drain takes too long, kill the process anyway.
      const forceTimer = setTimeout(() => {
        log.error('Graceful shutdown timed out — forcing exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceTimer.unref();

      // Close active transports first; long-lived SSE GET streams hold open
      // keep-alive connections that prevent httpServer.close() from completing.
      for (const transport of sessions.values()) {
        transport.close().catch((e) => log.error('Error closing transport', { err: e }));
      }
      sessions.clear();

      // Stop accepting new connections; callback fires when all existing
      // connections have closed.
      httpServer.close((err) => {
        if (err) log.error('Error closing HTTP server', { err });
        clearTimeout(forceTimer);
        log.info('Shutdown complete');
        process.exit(0);
      });

      // transport.close() tears down the SDK's web ReadableStream but does NOT
      // close the underlying Node socket of a standalone GET SSE stream (the
      // @hono/node-server bridge leaves it open). Those lingering keep-alive
      // sockets would otherwise block httpServer.close() until the backstop
      // timer forced exit code 1. Forcibly close them so close() can complete.
      //
      // closeAllConnections() exists on Node >= 18.2.0; engines only requires
      // >= 18.0.0, so optional-chain it. On 18.0.x–18.1.x it is absent and the
      // call no-ops, degrading to the backstop timer rather than throwing.
      httpServer.closeAllConnections?.();
    };

    // Use process.on (not .once) so a second signal hits the same handler and
    // triggers the force-exit branch above instead of re-invoking shutdown.
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } else {
    const transport = new StdioServerTransport();
    const server = buildServer({ allowInstallSkill: true });
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
