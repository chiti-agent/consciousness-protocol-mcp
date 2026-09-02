import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-agent-api-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { createVolemThread, getVolemThread, listVolemThreads, replyToVolemThread, runVolemAcceptance } =
  await import('../src/volem/agent-api.js');

saveKey('evm', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const config = {
  network: 'testnet' as const,
  near: { accountId: 'agent.testnet', registryContract: 'registry.testnet' },
  story: {
    evmAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    chainId: 'aeneid' as const,
    rpcUrl: 'http://rpc.invalid',
  },
  ipfs: {},
  volemApiUrl: 'http://volem.invalid',
};

after(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

const envelope = (authorization: string) =>
  JSON.parse(Buffer.from(authorization.slice(5).split('.')[0]!, 'base64url').toString('utf8')) as {
    action: string;
    path: string;
  };

describe('Volem agent API client', () => {
  it('keeps public thread reads unsigned and signs both thread writes', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization: string }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') ?? '' });
      return Response.json({ success: true });
    };
    try {
      await listVolemThreads(config, 25);
      await getVolemThread(config, 7);
      await createVolemThread({ config, title: 'A thread', body: 'Opening' });
      await replyToVolemThread({ config, parentId: 'cm123456789012345678901234', body: 'Reply' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(calls.slice(0, 2), [
      { url: 'http://volem.invalid/api/threads?limit=25', authorization: '' },
      { url: 'http://volem.invalid/api/threads/7', authorization: '' },
    ]);
    assert.deepEqual(
      calls.slice(2).map((call) => {
        const signed = envelope(call.authorization);
        return { action: signed.action, path: signed.path };
      }),
      [
        { action: 'thread.create', path: '/api/threads' },
        { action: 'thread.reply', path: '/api/threads/replies' },
      ],
    );
  });

  it('binds each of the ten dispatcher actions into the signed body and envelope', async () => {
    const originalFetch = globalThis.fetch;
    const observed: Array<{ envelopeAction: string; bodyAction: string }> = [];
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const parsedBody = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { action: string };
      observed.push({
        envelopeAction: envelope(headers.get('authorization') ?? '').action,
        bodyAction: parsedBody.action,
      });
      return Response.json({ success: true });
    };
    const actions = ['preview', 'start', 'resume', 'load', 'cancel', 'prepare', 'record', 'reconcile', 'confirm', 'finalize'] as const;
    try {
      for (const action of actions) await runVolemAcceptance({ config, action, body: {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(
      observed,
      actions.map((action) => ({ envelopeAction: `acceptance.${action}`, bodyAction: action })),
    );
  });
});
