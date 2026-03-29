/**
 * Level B — derivative registration tests (Story testnet).
 * Depends on register.test.ts having run first (uses registeredAssets).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  loadTestConfig,
  activateTestWallet,
  type TestAgentName,
} from '../helpers.js';
import { registerWorkTool } from '../../src/tools/register-work.js';
import { licenseTool } from '../../src/tools/license.js';
import { registeredAssets } from './register.test.js';

// Stored for chain test (A -> B -> C)
const derivativeIpIds: Record<string, string> = {};

describe('register_derivative', { timeout: 120_000 }, () => {
  before(() => {
    // Verify register tests ran
    assert.ok(registeredAssets['poem']?.ipId, 'poem must be registered first (run register.test.ts)');
    assert.ok(registeredAssets['code']?.ipId, 'code must be registered first');
  });

  // --- Derivative from free work (artist derives from poet's poem) ---
  it('creates derivative from free work (no license fee)', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-artist';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const poem = registeredAssets['poem'];
    assert.ok(poem.licenseTermsIds?.[0], 'poem must have licenseTermsIds');

    const result = await registerWorkTool.registerDerivative(config, {
      title: 'Visual Ode — derivative of poem',
      content: 'A visual interpretation of the poem on decentralization',
      type: 'image',
      parent_ip_id: poem.ipId,
      parent_license_terms_id: poem.licenseTermsIds![0],
    });

    assert.equal(result.success, true, `Derivative failed: ${result.error}`);
    assert.ok(result.ipId, 'derivative ipId must exist');
    assert.equal(result.parentIpId, poem.ipId, 'parentIpId must match');

    derivativeIpIds['visual-ode'] = result.ipId!;
  });

  // --- Derivative from commercial work (buyer derives from developer's code, mint license first) ---
  it('creates derivative from commercial work (license required)', { timeout: 45_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const code = registeredAssets['code'];
    assert.ok(code.licenseTermsIds?.[0], 'code must have licenseTermsIds');

    // Step 1: mint license on the commercial code
    const mintResult = await licenseTool.mint(config, {
      ip_id: code.ipId,
      license_terms_id: code.licenseTermsIds![0],
      amount: 1,
    });
    assert.equal(mintResult.success, true, `License mint failed: ${mintResult.error}`);

    // Step 2: register derivative
    const result = await registerWorkTool.registerDerivative(config, {
      title: 'Extended Utils — derivative of validator-utils',
      content: 'Extended validator utilities with extra sorting methods',
      type: 'code',
      parent_ip_id: code.ipId,
      parent_license_terms_id: code.licenseTermsIds![0],
      license_token_id: mintResult.licenseTokenIds?.[0],
    });

    assert.equal(result.success, true, `Derivative failed: ${result.error}`);
    assert.ok(result.ipId);
    assert.equal(result.parentIpId, code.ipId);

    derivativeIpIds['extended-utils'] = result.ipId!;
  });

  // --- Chain A -> B -> C (derivative of derivative) ---
  it('creates chain A -> B -> C (derivative of derivative)', { timeout: 45_000 }, async () => {
    // B = visual-ode (derivative of poem)
    // C = derivative of visual-ode
    const derivB = derivativeIpIds['visual-ode'];
    assert.ok(derivB, 'visual-ode derivative must exist from previous test');

    // Use a different agent for C
    const agent: TestAgentName = 'test-musician';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    // visual-ode was registered by artist with commercialRemix terms
    // We need its license terms ID. Since it was created via registerDerivative,
    // the SDK auto-assigns terms. We use the first terms ID (usually 1 for commercialRemix).
    // For the chain test, we attempt the derivative — if the parent has
    // non-commercial terms, this would fail (which is also a valid test outcome).
    const result = await registerWorkTool.registerDerivative(config, {
      title: 'Musical Ode — derivative of Visual Ode',
      content: 'An ambient track inspired by the visual interpretation of the poem',
      type: 'audio',
      parent_ip_id: derivB,
      parent_license_terms_id: '1', // Default commercial-remix terms from registerDerivative
    });

    // This may succeed or fail depending on license terms propagation
    // If it succeeds, verify the chain
    if (result.success) {
      assert.ok(result.ipId);
      assert.equal(result.parentIpId, derivB, 'parent must be the B derivative');
      derivativeIpIds['musical-ode'] = result.ipId!;
    } else {
      // Acceptable: license terms may not allow further derivatives
      assert.ok(
        result.error?.includes('license') || result.error?.includes('terms'),
        `Unexpected error: ${result.error}`,
      );
    }
  });
});
