/**
 * Level B integration tests for verify_provenance tool.
 * Tests basic provenance checks with local registrations data.
 *
 * Strategy: write fixture registrations.json with chain metadata,
 * then call verify which reads from local + attempts IPFS/NEAR lookups.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect HOME before importing
const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'verify-test-'));
process.env.HOME = TEMP_HOME;

const { verifyProvenanceTool } = await import('../../src/tools/verify.js');
import type { Config } from '../../src/config/store.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_DIR = join(TEMP_HOME, '.consciousness-protocol');
const REGISTRATIONS_FILE = join(CONFIG_DIR, 'registrations.json');

// Fixture: one asset with provenance metadata, one without
const FIXTURE_REGISTRATIONS = [
  {
    ipId: '0xPROVENANCE1111111111111111111111111111111',
    tokenId: '10',
    title: 'Provenance Test Poem',
    type: 'poem',
    license: 'free',
    revenueShare: 0,
    contentHash: 'sha256-provenance-test',
    ipfsUri: 'ipfs://QmFakeProvenanceTest',
    explorerUrl: 'https://aeneid.explorer.story.foundation/ipa/0xPROVENANCE1',
    registeredAt: '2026-03-23T10:00:00.000Z',
    nearAccount: 'poet.consciousness-protocol.testnet',
    chainSequence: 42,
    chainHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  },
  {
    ipId: '0xNOPROVENANCE22222222222222222222222222222',
    tokenId: '11',
    title: 'No Provenance Image',
    type: 'image',
    license: 'commercial-remix',
    revenueShare: 15,
    contentHash: 'sha256-no-provenance',
    ipfsUri: '',
    explorerUrl: 'https://aeneid.explorer.story.foundation/ipa/0xNOPROVENANCE2',
    registeredAt: '2026-03-23T11:00:00.000Z',
  },
];

function makeConfig(): Config {
  return {
    network: 'testnet',
    near: {
      accountId: 'test.testnet',
      registryContract: 'consciousness-protocol.testnet',
    },
    story: {
      evmAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'aeneid',
      rpcUrl: 'https://aeneid.storyrpc.io',
    },
    ipfs: { gateway: 'https://gateway.pinata.cloud/ipfs' },
  };
}

describe('Level B: Verify Provenance Integration', () => {
  before(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(REGISTRATIONS_FILE, JSON.stringify(FIXTURE_REGISTRATIONS, null, 2));
  });

  after(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  it('returns structured result for asset with provenance', { timeout: 15_000 }, async () => {
    const config = makeConfig();
    const result = await verifyProvenanceTool.verify(
      config,
      '0xPROVENANCE1111111111111111111111111111111',
    ) as any;

    assert.equal(result.success, true, 'should succeed');
    assert.equal(result.ipId, '0xPROVENANCE1111111111111111111111111111111');
    assert.ok(result.explorer, 'should have explorer URL');
    assert.ok(result.explorer.includes('aeneid'), 'explorer should be testnet');

    // Work info may be partial since IPFS is fake, but structure should exist
    assert.ok(result.work, 'should have work section');
    assert.ok(result.license || result.license === null, 'should have license section');
    assert.ok(result.actions, 'should have actions section');
    assert.ok(result.provenance, 'should have provenance section');
  });

  it('returns partial result for asset without provenance', { timeout: 15_000 }, async () => {
    const config = makeConfig();
    const result = await verifyProvenanceTool.verify(
      config,
      '0xNOPROVENANCE22222222222222222222222222222',
    ) as any;

    assert.equal(result.success, true);

    // Provenance should show null/missing values
    assert.ok(result.provenance, 'should have provenance section');
    assert.equal(result.provenance.chainSequence, null, 'no chain sequence');
    assert.equal(result.provenance.chainHash, null, 'no chain hash');
    assert.equal(result.provenance.nearAccount, null, 'no near account');
    assert.equal(result.provenance.verified, false, 'should not be verified');
  });

  it('returns result for unknown ipId (not in registrations)', { timeout: 15_000 }, async () => {
    const config = makeConfig();
    const result = await verifyProvenanceTool.verify(
      config,
      '0x0000000000000000000000000000000000099999',
    ) as any;

    assert.equal(result.success, true);
    // Work section should note that metadata is not available
    assert.ok(result.work, 'should have work section');
    if (result.work.note) {
      assert.ok(result.work.note.includes('not available') || result.work.note.includes('Not'), 'should indicate missing metadata');
    }
  });

  it('has actions section with tool references', { timeout: 15_000 }, async () => {
    const config = makeConfig();
    const result = await verifyProvenanceTool.verify(
      config,
      '0xPROVENANCE1111111111111111111111111111111',
    ) as any;

    assert.ok(result.actions, 'should have actions');
    assert.ok(result.actions.payRoyalty, 'should have payRoyalty action');
    assert.equal(result.actions.payRoyalty.tool, 'pay_royalty');
  });
});
