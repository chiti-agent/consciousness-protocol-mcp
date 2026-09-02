import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-client-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { createLogger } = await import('../src/logger.js');
const { jsonRequestBody, signedVolemRequest } = await import('../src/volem/client.js');
const { VolemRequestJournal } = await import('../src/volem/request-journal.js');

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

const decodeEnvelope = (authorization: string) => {
  const encoded = authorization.slice('EVM2 '.length).split('.')[0]!;
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    nonce: string;
    idempotencyKey: string;
    action: string;
    path: string;
  };
};

describe('signed Volem HTTP client', () => {
  it('reuses logical idempotency while signing each retry with a fresh replay nonce', async () => {
    const journal = new VolemRequestJournal(join(testHome, 'retry-journal.jsonl'));
    const authorizations: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('temporary', { status: 503 });
    };
    const body = jsonRequestBody({ title: 'one logical intent' });
    await signedVolemRequest({ config, action: 'thread.create', path: '/api/threads', body, journal, fetcher });
    await signedVolemRequest({ config, action: 'thread.create', path: '/api/threads', body, journal, fetcher });
    const first = decodeEnvelope(authorizations[0]!);
    const second = decodeEnvelope(authorizations[1]!);
    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.notEqual(first.nonce, second.nonce);
    assert.equal(first.action, 'thread.create');
    assert.equal(first.path, '/api/threads');
  });

  it('does not close a successful logical request until its caller consumes the response', async () => {
    const journal = new VolemRequestJournal(join(testHome, 'response-journal.jsonl'));
    const body = jsonRequestBody({ title: 'response may be lost' });
    const first = await signedVolemRequest({
      config,
      action: 'thread.create',
      path: '/api/threads',
      body,
      journal,
      fetcher: async () => Response.json({ success: true }),
    });
    const beforeConsumption = await signedVolemRequest({
      config,
      action: 'thread.create',
      path: '/api/threads',
      body,
      journal,
      fetcher: async () => Response.json({ success: true }),
    });
    assert.equal(beforeConsumption.request.idempotencyKey, first.request.idempotencyKey);
    beforeConsumption.complete();
    const afterConsumption = await signedVolemRequest({
      config,
      action: 'thread.create',
      path: '/api/threads',
      body,
      journal,
      fetcher: async () => Response.json({ success: true }),
    });
    assert.notEqual(afterConsumption.request.idempotencyKey, first.request.idempotencyKey);
  });

  it('uses V1 only when explicitly selected before a per-action deadline and logs it', async () => {
    const lines: string[] = [];
    let authorization = '';
    await signedVolemRequest({
      config,
      action: 'ip.event',
      path: '/api/ip/event',
      body: jsonRequestBody({ ipId: '0x1' }),
      journal: new VolemRequestJournal(join(testHome, 'legacy-journal.jsonl')),
      environment: {
        CP_VOLEM_AUTH_MODE: 'V1',
        CP_VOLEM_V1_EVENT_DEADLINE: '2099-01-01T00:00:00.000Z',
      },
      logger: createLogger({ sink: (line) => lines.push(line) }),
      fetcher: async (_url, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return new Response('{}', { status: 200 });
      },
    });
    assert.match(authorization, /^EVM /);
    assert.match(lines.join(''), /explicit Volem EVM V1 fallback/);
  });

  it('refuses an explicitly selected V1 fallback without a deadline', async () => {
    await assert.rejects(
      signedVolemRequest({
        config,
        action: 'ip.content-key',
        path: '/api/ip/0x0000000000000000000000000000000000000001/content-key',
        journal: new VolemRequestJournal(join(testHome, 'disabled-legacy-journal.jsonl')),
        environment: { CP_VOLEM_AUTH_MODE: 'V1' },
        fetcher: async () => {
          assert.fail('fetch must not run');
        },
      }),
      /disabled or past/,
    );
  });
});
