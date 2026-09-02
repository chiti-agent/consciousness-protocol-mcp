import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'cp-mcp-volem-tools-'));
process.env.HOME = testHome;

const { saveConfig, saveKey } = await import('../src/config/store.js');
const { buildServer } = await import('../src/mcp/server.js');

saveConfig({
  network: 'testnet',
  near: { accountId: 'reader.testnet', registryContract: 'consciousness-protocol.testnet' },
  story: {
    evmAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    chainId: 'aeneid',
    rpcUrl: 'http://rpc.invalid',
  },
  ipfs: {},
  volemApiUrl: 'http://volem.invalid',
});
saveKey('evm', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

after(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('local Volem MCP tools', () => {
  it('maps resume and load without preparing or broadcasting', async () => {
    const originalFetch = globalThis.fetch;
    const observed: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { action: string };
      observed.push(body.action);
      return Response.json({ success: true, resume: { state: 'PREPARING' } });
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer({ mode: 'local' });
    const client = new Client({ name: 'volem-tool-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'acceptance_resume', arguments: { offer_id: 'offer-1' } });
      await client.callTool({ name: 'acceptance_load', arguments: { attempt_id: 'attempt-1' } });
      assert.deepEqual(observed, ['resume', 'load']);
    } finally {
      globalThis.fetch = originalFetch;
      await client.close();
      await server.close();
    }
  });
});
