import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-registration-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { postToVolem, supportsGatedRegistration } = await import('../src/volem-registration.js');
const { registerWorkTool } = await import('../src/tools/register-work.js');

saveKey('evm', `0x${'11'.repeat(32)}`);

after(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('gated Volem persistence', () => {
  it('only permits gated registration with the Volem backend', () => {
    const base = {
      network: 'testnet' as const,
      near: { accountId: 'test.testnet', registryContract: 'registry.testnet' },
      story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid' as const, rpcUrl: 'http://rpc.invalid' },
      ipfs: {},
    };
    assert.equal(supportsGatedRegistration(base), true);
    assert.equal(supportsGatedRegistration({ ...base, backend: 'volem' }), true);
    assert.equal(supportsGatedRegistration({ ...base, backend: 'local' }), false);
    assert.equal(supportsGatedRegistration({ ...base, backend: 'story' }), false);
  });

  it('rejects a non-Volem gated registration before any upload or chain write', async () => {
    const result = await registerWorkTool.register({
      network: 'testnet',
      near: { accountId: 'test.testnet', registryContract: 'registry.testnet' },
      story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid', rpcUrl: 'http://rpc.invalid' },
      ipfs: {},
      backend: 'local',
    }, {
      title: 'Must not leave this process',
      content: 'secret',
      type: 'analysis',
      license: 'commercial-remix',
      content_access: 'gated',
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /requires backend=volem/);
  });

  it('requires an HTTP success acknowledgement', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('database unavailable', { status: 503 });
    try {
      const result = await postToVolem({
        network: 'testnet',
        near: { accountId: 'test.testnet', registryContract: 'registry.testnet' },
        story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid', rpcUrl: 'http://rpc.invalid' },
        ipfs: {},
        backend: 'volem',
        volemApiUrl: 'http://volem.invalid',
      }, { ipId: '0x0000000000000000000000000000000000000002' });
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns ok only for a successful Volem response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ success: true });
    try {
      const result = await postToVolem({
        network: 'testnet',
        near: { accountId: 'test.testnet', registryContract: 'registry.testnet' },
        story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid', rpcUrl: 'http://rpc.invalid' },
        ipfs: {},
        backend: 'volem',
        volemApiUrl: 'http://volem.invalid',
      }, { ipId: '0x0000000000000000000000000000000000000002' });
      assert.deepEqual(result, { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
