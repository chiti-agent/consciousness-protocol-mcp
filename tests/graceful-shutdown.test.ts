/**
 * Graceful shutdown tests.
 *
 * Verifies that the HTTP MCP server:
 * 1. Exits with code 0 on SIGTERM (not killed by signal).
 * 2. Exits with code 0 on SIGINT even when an active session exists (transport
 *    drain does not block httpServer.close()).
 *
 * Before the fix: SIGTERM/SIGINT cause the default Node behaviour (code=null,
 * signal='SIGTERM'/'SIGINT'). After the fix: registered handlers call
 * process.exit(0) after draining, so code=0, signal=null.
 *
 * Runs against src/ via tsx (no build dependency).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'src', 'index.ts');

// ── helpers (mirrored from http-transport.test.ts) ──────────────────────────

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
    clientInfo: { name: 'shutdown-test', version: '1.0.0' },
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
      env: {
        ...process.env,
        MCP_TRANSPORT: 'http',
        MCP_PORT: String(port),
        // Fast shutdown timeout so tests don't hang on the backstop timer.
        MCP_SHUTDOWN_TIMEOUT_MS: '5000',
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
    }, 20_000);

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

function sendRequest(
  port: number,
  opts: { method?: string; headers?: Record<string, string>; body?: string | null },
): Promise<{ status: number; body: string; sessionId?: string }> {
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

/**
 * Race `promise` against a timeout. Rejects if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('graceful shutdown', () => {
  it('SIGTERM causes exit code 0 (not killed by signal)', async () => {
    const port = await getFreePort();
    const server = await spawnServer(port);

    // Give the server a moment to be fully ready.
    await delay(200);

    // Send SIGTERM and wait for exit.
    server.child.kill('SIGTERM');

    const result = await withTimeout(
      server.exited,
      8_000,
      'server did not exit within 8s after SIGTERM',
    );

    assert.equal(
      result.code,
      0,
      `Expected exit code 0 after SIGTERM, got code=${result.code} signal=${result.signal}`,
    );
    assert.equal(
      result.signal,
      null,
      `Expected signal=null (clean exit) after SIGTERM, got signal=${result.signal}`,
    );
  });

  it('SIGINT with a long-lived SSE stream drains fast (shutdown unblocks httpServer.close)', async () => {
    const port = await getFreePort();
    const server = await spawnServer(port);

    // 1. Establish a session.
    const init = await sendRequest(port, { headers: JSON_HEADERS, body: INIT_BODY });
    assert.equal(init.status, 200, `init should return 200, got ${init.status}`);
    assert.ok(init.sessionId, 'server should return mcp-session-id on initialize');
    const sessionId = init.sessionId!;

    const sessionHeaders = { ...JSON_HEADERS, 'mcp-session-id': sessionId };

    // 2. Complete the handshake — the SDK only accepts a standalone GET SSE
    //    stream after the session has received notifications/initialized.
    await sendRequest(port, {
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await delay(100);

    // 3. Open a long-lived standalone GET SSE stream and keep it open. The
    //    server holds this connection open indefinitely, so without
    //    the socket teardown in shutdown(), httpServer.close() would block until
    //    the backstop timer (MCP_SHUTDOWN_TIMEOUT_MS=5000) forced exit code 1.
    //    We capture the GET status to prove the stream was actually accepted
    //    (a 4xx/405 would mean no blocking connection -> a hollow test).
    const sseStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'GET',
          headers: { 'mcp-session-id': sessionId, accept: 'text/event-stream' },
        },
        (res) => {
          // Do NOT wait for 'end' — the stream is held open by the server.
          // Swallow the inevitable connection reset/abort at shutdown so it
          // does not surface as an unhandled error and fail the test.
          res.on('error', () => {});
          res.on('aborted', () => {});
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(
      sseStatus,
      200,
      `standalone GET SSE stream must be accepted (200) so it actually blocks ` +
        `httpServer.close(); got ${sseStatus}. A non-200 means the test holds no ` +
        `open connection and proves nothing about transport drain.`,
    );

    // Let the SSE connection fully establish on the server side.
    await delay(200);

    // 4. Signal shutdown and measure how long the drain takes.
    const killAt = Date.now();
    server.child.kill('SIGINT');

    const result = await withTimeout(
      server.exited,
      8_000,
      'server did not exit within 8s after SIGINT with an open SSE stream',
    );
    const drainMs = Date.now() - killAt;

    assert.equal(
      result.code,
      0,
      `Expected exit code 0 after SIGINT with open SSE stream, got code=${result.code} signal=${result.signal}`,
    );
    assert.equal(
      result.signal,
      null,
      `Expected signal=null (clean exit), got signal=${result.signal}`,
    );

    // 5. The drain must complete WELL before the 5000ms backstop. If it does,
    //    shutdown() actively tore down the SSE socket (transport.close() ends the
    //    SDK ReadableStream, httpServer.closeAllConnections() reaps the lingering
    //    Node socket), letting httpServer.close() finish promptly. If the backstop
    //    had fired instead, exit code would be 1 (already asserted 0), drainMs ~5000.
    assert.ok(
      drainMs < 4_000,
      `drain took ${drainMs}ms; expected < 4000ms (backstop is 5000ms). A value ` +
        `near 5000ms means transport.close() did NOT unblock httpServer.close() ` +
        `and the backstop forced the exit instead.`,
    );
  });
});
