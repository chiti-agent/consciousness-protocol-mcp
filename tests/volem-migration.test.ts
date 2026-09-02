import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-migration-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { postToVolem } = await import('../src/volem-registration.js');
const { postVolemEvent } = await import('../src/volem-events.js');
const { requestVolemContentKey } = await import('../src/tools/content.js');

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
  backend: 'volem' as const,
  volemApiUrl: 'http://volem.invalid',
};

after(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

const decodeEnvelope = (authorization: string) => {
  const encoded = authorization.slice('EVM2 '.length).split('.')[0]!;
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    action: string;
    path: string;
    bodySha256: string;
  };
};

describe('Volem V1 call-site migration', () => {
  it('sends EVM2 from registration, event, and content-key call sites', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: init?.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : '',
      });
      return Response.json({ success: true, key: 'secret' });
    };
    try {
      assert.deepEqual(await postToVolem(config, { ipId: '0x0000000000000000000000000000000000000001' }), { ok: true });
      await postVolemEvent(config, {
        ip_id: '0x0000000000000000000000000000000000000001',
        event_type: 'LICENSE_MINTED',
      });
      assert.equal(
        (await requestVolemContentKey(config, '0x0000000000000000000000000000000000000001')).response.ok,
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 3);
    const envelopes = requests.map((request) => decodeEnvelope(request.authorization));
    assert.deepEqual(
      envelopes.map(({ action, path }) => ({ action, path })),
      [
        { action: 'ip.register', path: '/api/ip/register' },
        { action: 'ip.event', path: '/api/ip/event' },
        {
          action: 'ip.content-key',
          path: '/api/ip/0x0000000000000000000000000000000000000001/content-key',
        },
      ],
    );
    assert.notEqual(envelopes[0]!.bodySha256, envelopes[2]!.bodySha256);
    assert.equal(requests[2]!.body, '');
  });
});
