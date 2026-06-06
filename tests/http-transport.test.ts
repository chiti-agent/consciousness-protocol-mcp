/**
 * HTTP transport crash regression tests.
 *
 * Bug: the HTTP MCP server (--http / MCP_TRANSPORT=http) used a single shared
 * McpServer instance and called `server.connect(transport)` on every new-session
 * request. The MCP SDK's `Protocol.connect` throws "Already connected to a
 * transport" on the second connect. That throw happened inside an async
 * `http.createServer` callback with no try/catch, so it became an unhandled
 * promise rejection and Node terminated the process with exit code 1.
 *
 * Repro strategy: spawn the ACTUAL server in HTTP mode on a free port, wait for
 * the "listening" line on stderr, then send — via node:http only (Ivan's rules:
 * no curl, no python) — two requests that each take the new-session branch
 * (no mcp-session-id header). Before the fix, the second request crashes the
 * child process (exit code 1). After the fix, the child stays alive and serves
 * a second independent session.
 *
 * Runs against src/ via tsx (no build dependency).
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
    clientInfo: { name: 'repro-test', version: '1.0.0' },
  },
});

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
  /** Resolves with {code, signal} when the child exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** True once the child has exited. */
  isDead: () => boolean;
}

function spawnServer(port: number): Promise<SpawnedServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx/esm', SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MCP_TRANSPORT: 'http', MCP_PORT: String(port) },
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
  sessionId?: string;
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
            sessionId: res.headers['mcp-session-id'] as string | undefined,
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

describe('HTTP transport — second session must not crash the process', () => {
  let server: SpawnedServer | undefined;

  after(() => {
    server?.child.kill('SIGKILL');
  });

  it('serves two independent new-session requests without exiting', async () => {
    const port = await getFreePort();
    server = await spawnServer(port);

    // First new-session init: takes the new-session branch, server.connect(transport) #1.
    const first = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
    assert.equal(first.status, 200, 'first init should return 200');

    // Give the event loop a tick; the process must still be alive.
    await delay(150);
    assert.equal(server.isDead(), false, 'process must be alive after the first session');

    // Second new-session init (no mcp-session-id): takes the new-session branch again.
    // On the buggy code this triggers server.connect(transport) #2 ->
    // "Already connected to a transport" -> unhandled rejection -> exit code 1.
    let secondStatus = 0;
    try {
      const second = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
      secondStatus = second.status;
    } catch (err) {
      // A socket hang up here means the server died mid-response (the bug).
      assert.fail(
        `second new-session request crashed the connection: ${(err as Error).message}`,
      );
    }

    // Let any pending crash surface.
    await delay(250);

    assert.equal(
      server.isDead(),
      false,
      'process must NOT exit when a second session connects (regression: it exited with code 1)',
    );
    assert.ok(
      secondStatus >= 200 && secondStatus < 500,
      `second session should get a normal HTTP response, got ${secondStatus}`,
    );
  });

  it('does not crash on a malformed request (rejects transport input)', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      // Establish one session first.
      await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
      await delay(100);

      // Malformed JSON body — must produce an HTTP error, not a process exit.
      const res = await sendRequest(port, { headers: JSON_HEADERS, body: '{ not json' });
      await delay(200);

      assert.equal(local.isDead(), false, 'process must survive a malformed request');
      assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    } finally {
      local.child.kill('SIGKILL');
    }
  });

  it('routes a reused mcp-session-id back to its existing session', async () => {
    const port = await getFreePort();
    const local = await spawnServer(port);
    try {
      // 1. Initialize a new session (no session header) and capture the id the
      //    server assigns. sessionId is only set inside handleRequest while the
      //    initialize message is processed, so the server MUST register the
      //    transport from the onsessioninitialized callback — not from a
      //    `transport.sessionId` check that runs before handleRequest.
      const init = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
      assert.equal(init.status, 200, 'initialize should return 200');
      assert.ok(
        init.sessionId && init.sessionId.length > 0,
        'server must return an mcp-session-id header on initialize',
      );
      const sessionId = init.sessionId!;
      await delay(100);

      const sessionHeaders = { ...JSON_HEADERS, 'mcp-session-id': sessionId };

      // 2. Faithful handshake: send notifications/initialized with the session id.
      //    Status is tolerated (202 / 200); we just complete the lifecycle.
      await sendRequest(port, {
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      await delay(100);

      // 3. Reuse the captured session id for a real request. On the buggy code
      //    the sessions map is empty, so this misroutes into the new-session
      //    branch, hits a fresh uninitialized transport, and returns a 4xx.
      const toolsList = await sendRequest(port, {
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      await delay(150);

      assert.equal(local.isDead(), false, 'process must stay alive on session reuse');
      assert.equal(
        toolsList.status,
        200,
        `reused session should be routed to its existing transport (got HTTP ${toolsList.status}; ` +
          `4xx means the session map was empty and the request misrouted to a fresh transport)`,
      );
    } finally {
      local.child.kill('SIGKILL');
    }
  });
});
