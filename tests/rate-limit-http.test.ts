/**
 * Integration tests: per-IP rate limiting on the Streamable HTTP transport.
 *
 * Spawns the real server with MCP_RATE_LIMIT_CAPACITY=1 and
 * MCP_RATE_LIMIT_REFILL_PER_SEC=0 so the bucket exhausts after one request
 * and never refills. Two POST /mcp requests from the same socket should
 * produce the second returning HTTP 429 with a Retry-After header.
 *
 * The server is spawned in HTTP mode using the same pattern as
 * tests/http-transport.test.ts (tsx/esm, no build dependency).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'src', 'index.ts');

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rate-limit-test', version: '1.0.0' },
  },
});

// ---------------------------------------------------------------------------
// Helpers (same pattern as http-transport.test.ts)
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not determine free port')));
      }
    });
    srv.on('error', reject);
  });
}

interface SpawnedServer {
  child: ChildProcess;
  port: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isDead: () => boolean;
}

function spawnServer(port: number, extraEnv: Record<string, string> = {}): Promise<SpawnedServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx/esm', SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PORT: String(port),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let dead = false;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      child.on('exit', (code, signal) => {
        dead = true;
        res({ code, signal });
      });
    });

    const startupTimeout = setTimeout(() => {
      reject(new Error('timed out waiting for server to listen'));
    }, 20000);

    child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(startupTimeout);
        resolve({ child, port, exited, isDead: () => dead });
      }
    });

    child.on('exit', (code) => {
      clearTimeout(startupTimeout);
      reject(new Error(`server exited before listening (code ${code})`));
    });
  });
}

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function sendRequest(
  port: number,
  opts: { method?: string; headers?: Record<string, string>; body?: string | null },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: opts.method ?? 'POST',
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers as Record<string, string | string[] | undefined>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Rate limiting — HTTP transport integration', () => {
  let server: SpawnedServer | undefined;

  after(() => {
    server?.child.kill('SIGKILL');
  });

  it('returns 429 on the second request when capacity=1 and refillPerSec=0', async () => {
    const port = await getFreePort();
    server = await spawnServer(port, {
      MCP_RATE_LIMIT_CAPACITY: '1',
      MCP_RATE_LIMIT_REFILL_PER_SEC: '0',
    });

    // First request: should be allowed (consumes the single token)
    const first = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
    assert.ok(
      first.status >= 200 && first.status < 500,
      `first request should not be 429 or 5xx, got ${first.status}`,
    );
    assert.notEqual(first.status, 429, 'first request must not be rate-limited');

    // Second request (same IP — 127.0.0.1 — bucket is now empty): must get 429
    const second = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
    assert.equal(second.status, 429, `second request must be rate-limited (got ${second.status})`);

    // Retry-After header must be present and numeric
    const retryAfter = second.headers['retry-after'];
    assert.ok(
      retryAfter !== undefined,
      'rate-limited response must include Retry-After header',
    );
    assert.ok(
      !isNaN(Number(retryAfter)),
      `Retry-After must be numeric, got: ${String(retryAfter)}`,
    );

    // Response body must be a valid JSON-RPC error object with code -32000
    let parsed: { jsonrpc: string; error: { code: number; message: string }; id: null };
    assert.doesNotThrow(() => {
      parsed = JSON.parse(second.body);
    }, 'rate-limit response body must be valid JSON');
    assert.equal(parsed!.error.code, -32000, 'error code must be -32000');
    assert.ok(
      typeof parsed!.error.message === 'string' && parsed!.error.message.length > 0,
      'error message must be a non-empty string',
    );

    // The server process must still be alive after returning a 429
    await delay(200);
    assert.equal(server.isDead(), false, 'server must stay alive after returning 429');
  });

  it('does not rate-limit when MCP_RATE_LIMIT_DISABLED=1', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port, {
      MCP_RATE_LIMIT_CAPACITY: '1',
      MCP_RATE_LIMIT_REFILL_PER_SEC: '0',
      MCP_RATE_LIMIT_DISABLED: '1',
    });
    try {
      // Both requests should succeed (limiting is disabled)
      const first = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
      assert.notEqual(first.status, 429, 'first request must not be rate-limited when disabled');

      const second = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
      assert.notEqual(second.status, 429, 'second request must not be rate-limited when disabled');
    } finally {
      local.child.kill('SIGKILL');
    }
  });

  it('default capacity is high enough that normal test traffic is not rate-limited', async () => {
    const port = await getFreePort();
    // No rate-limit env vars set → defaults apply (capacity=120, refillPerSec=2)
    const local = await spawnServer(port);
    try {
      // Send several requests — should all pass with default capacity of 120
      for (let i = 0; i < 5; i++) {
        const r = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
        assert.notEqual(r.status, 429, `request ${i + 1} should not be rate-limited with default config`);
      }
    } finally {
      local.child.kill('SIGKILL');
    }
  });
});
