/**
 * Health and readiness endpoint tests.
 *
 * Verifies that GET /health and GET /ready are served unauthenticated, before
 * rate-limiting and session logic, by the Streamable HTTP transport.
 *
 * Rules:
 * - node:http only (no curl, no python)
 * - spawn the real server via tsx/esm so changes to src/ are reflected without
 *   a separate build step
 * - detect startup by grepping child stderr for the substring "listening on"
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
}

function spawnServer(port: number): Promise<SpawnedServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx/esm', SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MCP_TRANSPORT: 'http', MCP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startupTimeout = setTimeout(() => {
      reject(new Error('timed out waiting for server to listen'));
    }, 20_000);

    child.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(startupTimeout);
        resolve({ child, port });
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
  headers: http.IncomingHttpHeaders;
}

/** Make a plain HTTP request to the spawned server at the given path. */
function httpGet(port: number, path: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Health and readiness endpoints', () => {
  let server: SpawnedServer | undefined;

  after(() => {
    server?.child.kill('SIGKILL');
  });

  it('GET /health returns 200 with {"status":"ok"}', async () => {
    const port = await getFreePort();
    server = await spawnServer(port);

    const res = await httpGet(port, '/health');
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(
      res.headers['content-type'],
      'application/json',
      'Content-Type must be application/json',
    );
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.deepEqual(body, { status: 'ok' });
  });

  it('GET /ready returns 200 with {"status":"ready"} when not shutting down', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      const res = await httpGet(port, '/ready');
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      assert.equal(
        res.headers['content-type'],
        'application/json',
        'Content-Type must be application/json',
      );
      const body = JSON.parse(res.body) as Record<string, unknown>;
      assert.deepEqual(body, { status: 'ready' });
    } finally {
      local.child.kill('SIGKILL');
    }
  });

  it('HEAD /health returns 200 with empty body', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      const res = await httpGet(port, '/health', 'HEAD');
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      assert.equal(res.body, '', 'HEAD response body must be empty');
    } finally {
      local.child.kill('SIGKILL');
    }
  });

  it('POST /health returns 405 with Allow: GET, HEAD header', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      const res = await httpGet(port, '/health', 'POST');
      assert.equal(res.status, 405, `expected 405, got ${res.status}`);
      const allow = res.headers['allow'] ?? '';
      assert.ok(allow.includes('GET'), `Allow header must include GET, got: "${allow}"`);
    } finally {
      local.child.kill('SIGKILL');
    }
  });

  it('GET /unknown still returns 404 (existing fallthrough not broken)', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      const res = await httpGet(port, '/unknown');
      assert.equal(res.status, 404, `expected 404, got ${res.status}`);
    } finally {
      local.child.kill('SIGKILL');
    }
  });
});
