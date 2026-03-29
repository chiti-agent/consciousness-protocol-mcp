/**
 * Level B integration tests for setup tool.
 * Tests actual setupAgent function with a temporary config directory.
 *
 * Strategy: redirect HOME to temp dir so config/keys go to temp location.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect HOME before importing setup module
const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'setup-test-'));
process.env.HOME = TEMP_HOME;

const { setupAgent } = await import('../../src/tools/setup.js');

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_DIR = join(TEMP_HOME, '.consciousness-protocol');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const KEYS_DIR = join(CONFIG_DIR, 'keys');

describe('Level B: Setup Tool Integration', () => {
  after(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  it('creates config and keys for a new agent', async () => {
    const result = await setupAgent({
      agent_name: 'test-agent',
      network: 'testnet',
    }) as any;

    assert.equal(result.status, 'configured');
    assert.equal(result.network, 'testnet');
    assert.equal(result.story_chain, 'aeneid');
    assert.ok(result.evm_address, 'should have EVM address');
    assert.match(result.evm_address, /^0x[a-fA-F0-9]{40}$/, 'valid EVM address');
    assert.ok(result.near_account, 'should have NEAR account');

    // Verify files were created
    assert.ok(existsSync(CONFIG_FILE), 'config.json should exist');
    assert.ok(existsSync(KEYS_DIR), 'keys dir should exist');
    assert.ok(existsSync(join(KEYS_DIR, 'evm.json')), 'evm key should exist');

    // Verify config content
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    assert.equal(config.network, 'testnet');
    assert.equal(config.story.chainId, 'aeneid');
    assert.equal(config.story.evmAddress, result.evm_address);
  });

  it('is idempotent — running twice does not crash or overwrite keys', async () => {
    // Read the EVM key from first run
    const firstKey = JSON.parse(readFileSync(join(KEYS_DIR, 'evm.json'), 'utf-8'));

    const result = await setupAgent({
      agent_name: 'test-agent',
      network: 'testnet',
    }) as any;

    assert.equal(result.status, 'configured');

    // Key should NOT be overwritten
    const secondKey = JSON.parse(readFileSync(join(KEYS_DIR, 'evm.json'), 'utf-8'));
    assert.equal(firstKey.privateKey, secondKey.privateKey, 'EVM key should not be overwritten');
  });

  it('accepts explicit EVM private key', async () => {
    // Use a known test key (not a real wallet)
    const testPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

    const result = await setupAgent({
      agent_name: 'test-agent-explicit',
      network: 'testnet',
      evm_private_key: testPk,
    }) as any;

    assert.equal(result.status, 'configured');
    // The address for this well-known Hardhat key #0
    assert.equal(
      result.evm_address.toLowerCase(),
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      'should derive correct address from known private key',
    );
  });

  it('saves NEAR key when provided', async () => {
    const result = await setupAgent({
      agent_name: 'test-agent-near',
      network: 'testnet',
      near_account: 'test.testnet',
      near_private_key: 'ed25519:test-fake-near-key-for-testing',
    }) as any;

    assert.equal(result.near_account, 'test.testnet');
    assert.ok(existsSync(join(KEYS_DIR, 'near.json')), 'NEAR key should be saved');
  });
});
