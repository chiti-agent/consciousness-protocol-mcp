/**
 * HTTP transport auth tests — verifies API-key enforcement on the /mcp
 * Streamable HTTP endpoint when MCP_API_KEY is set.
 *
 * Spawns the built server (dist/index.js) as a child process with --http,
 * a known MCP_API_KEY, and a high random port, then drives it over HTTP.
 *
 * Note on isolation: requests that fail auth never reach the MCP transport,
 * so they can safely share one long-lived server. A request with a VALID key
 * does reach the transport; a non-handshake body makes the MCP layer answer
 * 400/406 and can then tear the connection/process down, so each
 * "valid key accepted" assertion runs against its own freshly spawned server.
 *
 * Uses Node.js built-in test runner (no external deps).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const SERVER_ENTRY = join(import.meta.dirname, '..', 'dist', 'index.js');
const API_KEY = 'test-secret-key-0xCAFEBABE';

let portCounter = 40000 + Math.floor(Math.random() * 20000);
function nextPort(): number {
  return portCounter++;
}

interface RunningServer {
  child: ChildProcess;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Spawn the built server with auth enabled on a fresh port and resolve once it
 * prints its "listening" line on stderr (logged via console.error).
 */
function startServer(): Promise<RunningServer> {
  const port = nextPort();
  const child = spawn(process.execPath, [SERVER_ENTRY, '--http'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http',
      MCP_PORT: String(port),
      MCP_API_KEY: API_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stop = async (): Promise<void> => {
    if (!child.killed) {
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      reject(new Error('Timed out waiting for server to start'));
    }, 15000);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (chunk.toString().includes('listening')) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${port}/mcp`, stop });
      }
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('HTTP transport API-key auth (rejection cases share one server)', () => {
  let server: RunningServer;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.stop();
  });

  it('rejects a POST with no key (401)', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Unauthorized' });
  });

  it('rejects a POST with the wrong Bearer key (401)', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer totally-wrong-key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects a GET with a wrong X-API-Key (401)', async () => {
    const res = await fetch(server.url, {
      method: 'GET',
      headers: { 'X-API-Key': 'nope' },
    });
    assert.equal(res.status, 401);
  });

  it('rejects a DELETE with no key (401), before session routing', async () => {
    const res = await fetch(server.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'does-not-exist' },
    });
    assert.equal(res.status, 401);
  });
});

describe('HTTP transport API-key auth (acceptance cases, one server each)', () => {
  it('accepts the correct key via Authorization: Bearer (not 401)', async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      // The MCP layer may answer 400/406 for a non-handshake body — that's fine.
      // The contract here is only that a valid key is NOT rejected as 401.
      assert.notEqual(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  it('accepts the correct key via X-API-Key (not 401)', async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      assert.notEqual(res.status, 401);
    } finally {
      await server.stop();
    }
  });
});
