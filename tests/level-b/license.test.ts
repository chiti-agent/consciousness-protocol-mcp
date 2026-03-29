/**
 * Level B — license minting, royalty payment, revenue claiming (Story testnet).
 * Depends on register.test.ts having run first.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTestConfig,
  activateTestWallet,
  type TestAgentName,
} from '../helpers.js';
import { licenseTool } from '../../src/tools/license.js';
import { royaltyTool } from '../../src/tools/royalty.js';
import { registeredAssets } from './register.test.js';

describe('license + royalty', { timeout: 180_000 }, () => {
  before(() => {
    assert.ok(registeredAssets['code']?.ipId, 'code must be registered first');
    assert.ok(registeredAssets['poem']?.ipId, 'poem must be registered first');
  });

  // --- mint_license for commercial asset ---
  it('mints license for commercial asset (developer code)', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const code = registeredAssets['code'];
    assert.ok(code.licenseTermsIds?.[0], 'code must have licenseTermsIds');

    const result = await licenseTool.mint(config, {
      ip_id: code.ipId,
      license_terms_id: code.licenseTermsIds![0],
      amount: 1,
    });

    assert.equal(result.success, true, `Mint failed: ${result.error}`);
    assert.ok(result.licenseTokenIds?.length, 'must return license token IDs');
    assert.ok(result.txHash, 'must return txHash');
  });

  // --- mint_license for free asset ---
  it('mints license for free asset (poet poem)', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const poem = registeredAssets['poem'];
    assert.ok(poem.licenseTermsIds?.[0], 'poem must have licenseTermsIds');

    const result = await licenseTool.mint(config, {
      ip_id: poem.ipId,
      license_terms_id: poem.licenseTermsIds![0],
      amount: 1,
    });

    assert.equal(result.success, true, `Mint failed: ${result.error}`);
    assert.ok(result.licenseTokenIds?.length);
  });

  // --- pay_royalty to IP with vault ---
  it('pays royalty to developer code IP', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const code = registeredAssets['code'];

    const result = await royaltyTool.pay(config, {
      receiver_ip_id: code.ipId,
      amount: '0.001', // Small test amount in WIP
    });

    assert.equal(result.success, true, `Pay royalty failed: ${result.error}`);
    assert.ok(result.txHash, 'must return txHash');
    assert.equal(result.receiver, code.ipId);
  });

  // --- claim_revenue after royalty payment ---
  it('claims revenue for developer code', { timeout: 30_000 }, async () => {
    // Developer claims their own revenue
    const agent: TestAgentName = 'test-developer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const code = registeredAssets['code'];

    const result = await royaltyTool.claim(config, {
      ip_id: code.ipId,
    });

    assert.equal(result.success, true, `Claim failed: ${result.error}`);
    // Revenue may or may not have accumulated depending on timing
    assert.ok(result.total_ips_checked !== undefined || result.claimed !== undefined);
  });
});
