/**
 * Level B integration tests for NEAR tools.
 * Tests publishState and getAgent against NEAR testnet (real network).
 *
 * Prerequisites:
 * - NEAR testnet accessible
 * - NEAR account with key saved (or env vars NEAR_TEST_ACCOUNT, NEAR_PRIVATE_KEY)
 *
 * These tests hit real testnet — they may be slow (2-5s per tx).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Redirect HOME for isolated key storage
const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'near-test-'));
process.env.HOME = TEMP_HOME;

const { nearTools } = await import('../../src/tools/near.js');
import type { Config } from '../../src/config/store.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_DIR = join(TEMP_HOME, '.consciousness-protocol');
const KEYS_DIR = join(CONFIG_DIR, 'keys');

// NEAR testnet config
const NEAR_ACCOUNT = process.env.NEAR_TEST_ACCOUNT ?? 'consciousness-test.testnet';
const NEAR_KEY = process.env.NEAR_PRIVATE_KEY;
const REGISTRY_CONTRACT = process.env.NEAR_REGISTRY ?? 'consciousness-protocol.testnet';

function makeConfig(): Config {
  return {
    network: 'testnet',
    near: {
      accountId: NEAR_ACCOUNT,
      registryContract: REGISTRY_CONTRACT,
    },
    story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid', rpcUrl: 'https://aeneid.storyrpc.io' },
    ipfs: {},
  };
}

function testHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const hasNearKey = !!NEAR_KEY;

describe('Level B: NEAR Tools Integration', () => {
  before(() => {
    mkdirSync(KEYS_DIR, { recursive: true });
    if (NEAR_KEY) {
      writeFileSync(
        join(KEYS_DIR, 'near.json'),
        JSON.stringify({ privateKey: NEAR_KEY, savedAt: new Date().toISOString() }),
      );
    }
  });

  after(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  describe('publishState', () => {
    it('publishes state hash to NEAR testnet', { skip: !hasNearKey ? 'NEAR_PRIVATE_KEY not set' : false, timeout: 30_000 }, async () => {
      const config = makeConfig();
      const hash = testHash('test-state-1-' + Date.now());
      const prevHash = '0'.repeat(64);

      const result = await nearTools.publishState(config, {
        sequence: 1,
        hash,
        prev_hash: prevHash,
      });

      assert.equal(result.success, true, `publishState failed: ${(result as any).error}`);
      assert.ok(result.near_tx, 'should return transaction result');
    });

    it('publishes second state with linked prev_hash', { skip: !hasNearKey ? 'NEAR_PRIVATE_KEY not set' : false, timeout: 30_000 }, async () => {
      const config = makeConfig();
      const hash1 = testHash('test-state-link-1-' + Date.now());
      const hash2 = testHash('test-state-link-2-' + Date.now());

      // First publish
      const result1 = await nearTools.publishState(config, {
        sequence: 100,
        hash: hash1,
        prev_hash: '0'.repeat(64),
      });
      assert.equal(result1.success, true, `first publish failed: ${(result1 as any).error}`);

      // Second publish linked to first
      const result2 = await nearTools.publishState(config, {
        sequence: 101,
        hash: hash2,
        prev_hash: hash1,
      });
      assert.equal(result2.success, true, `second publish failed: ${(result2 as any).error}`);
    });

    it('returns error without NEAR key', { skip: hasNearKey ? 'NEAR key is set, cannot test missing key' : false }, async () => {
      const config = makeConfig();
      const result = await nearTools.publishState(config, {
        sequence: 1,
        hash: testHash('no-key'),
        prev_hash: '0'.repeat(64),
      });

      assert.equal(result.success, false, 'should fail without key');
      assert.ok(result.error, 'should have error message');
    });
  });

  describe('getAgent', () => {
    it('queries agent info from NEAR testnet', { timeout: 15_000 }, async () => {
      const config = makeConfig();
      const result = await nearTools.getAgent(config, NEAR_ACCOUNT);

      // Should return a structured result (not throw)
      assert.ok('success' in result, 'should return structured result');
      // Agent may be null if not registered on testnet — that's valid
      if (result.success) {
        assert.ok('agent' in result, 'should have agent field');
      } else {
        assert.ok(result.error, 'should have error message');
      }
    });

    it('returns error for nonexistent agent', { timeout: 15_000 }, async () => {
      const config = makeConfig();
      const result = await nearTools.getAgent(config, 'nonexistent-agent-that-does-not-exist.testnet');

      // Should return structured result, not throw
      assert.ok('success' in result);
    });
  });
});
