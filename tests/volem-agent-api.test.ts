import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-agent-api-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { createVolemThread, getVolemThread, listVolemThreads, replyToVolemThread, runVolemAcceptance, runVolemOffer } =
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
    idempotencyKey: string;
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

  describe('offer negotiation route', () => {
    const NEGOTIATION = '0b5f9f0a-5a55-4b58-8c47-9a8a1c8e6f10';
    const CALLER_KEY = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const cases = [
      { action: 'list', body: { limit: 20 }, write: false },
      { action: 'conversation', body: { negotiationId: NEGOTIATION, afterSequence: 4, limit: 50 }, write: false },
      { action: 'message', body: { negotiationId: NEGOTIATION, body: 'Thank you.' }, write: true },
      { action: 'counter', body: { negotiationId: NEGOTIATION, fee: '2', share: 10, note: 'Fair.' }, write: true },
      { action: 'decline', body: { offerId: 'cm123456789012345678901234', fee: '3', share: 5 }, write: true },
      { action: 'mark-read', body: { negotiationId: NEGOTIATION, upToSequence: 7 }, write: false },
    ] as const;

    const capture = async (run: () => Promise<unknown>) => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ url: string; method: string | undefined; authorization: string; body: unknown }> = [];
      globalThis.fetch = async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get('authorization') ?? '',
          body: JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')),
        });
        return Response.json({ success: true });
      };
      try {
        await run();
      } finally {
        globalThis.fetch = originalFetch;
      }
      return calls;
    };

    it('posts each action to the single route with its envelope action, exact body and no query', async () => {
      const calls = await capture(async () => {
        for (const { action, body, write } of cases) {
          await runVolemOffer({ config, action, body, ...(write ? { idempotencyKey: CALLER_KEY } : {}) });
        }
      });
      assert.equal(calls.length, cases.length);
      calls.forEach((call, index) => {
        const expected = cases[index]!;
        const signed = envelope(call.authorization);
        assert.equal(call.url, 'http://volem.invalid/api/contribution-offers');
        assert.equal(call.method, 'POST');
        assert.equal(signed.action, `offer.${expected.action}`);
        assert.equal(signed.path, '/api/contribution-offers');
        assert.deepEqual(call.body, { action: expected.action, ...expected.body });
      });
    });

    it('mints a fresh UUIDv4 per read and keeps the caller key on a write or an explicit read key', async () => {
      const calls = await capture(async () => {
        await runVolemOffer({ config, action: 'list', body: {} });
        await runVolemOffer({ config, action: 'list', body: {} });
        await runVolemOffer({ config, action: 'conversation', body: { negotiationId: NEGOTIATION } });
        await runVolemOffer({ config, action: 'mark-read', body: { negotiationId: NEGOTIATION, upToSequence: 1 } });
        await runVolemOffer({ config, action: 'list', body: {}, idempotencyKey: CALLER_KEY });
        await runVolemOffer({
          config,
          action: 'message',
          body: { negotiationId: NEGOTIATION, body: 'Hello' },
          idempotencyKey: CALLER_KEY,
        });
      });
      const keys = calls.map((call) => envelope(call.authorization).idempotencyKey);
      const minted = keys.slice(0, 4);
      for (const key of minted) assert.match(key, UUID_V4);
      assert.equal(new Set(minted).size, 4, 'each read mints its own key');
      assert.notEqual(minted[0], CALLER_KEY);
      assert.deepEqual(keys.slice(4), [CALLER_KEY, CALLER_KEY]);
    });

    it('reports the key it used with the server answer', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => Response.json({ success: true, negotiations: [] });
      try {
        const answer = await runVolemOffer({ config, action: 'list', body: {} });
        assert.match(answer.idempotencyKey, UUID_V4);
        assert.deepEqual(answer.result, { success: true, negotiations: [] });
        const written = await runVolemOffer({
          config,
          action: 'counter',
          body: { negotiationId: NEGOTIATION, fee: '1', share: 1 },
          idempotencyKey: CALLER_KEY,
        });
        assert.equal(written.idempotencyKey, CALLER_KEY);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
