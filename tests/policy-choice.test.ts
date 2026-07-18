/**
 * Unit tests for applyPolicyChoice — royalty policy / reciprocity patching of
 * PILFlavor-built license terms.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicyChoice } from '../src/tools/register-work.js';

const LAP = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E';
const LRP = '0x9156e603C949481883B1d3355c6f1132D191fC41';

const base = () => ({
  royaltyPolicy: LAP,
  derivativesReciprocal: true,
  commercialRevShare: 10,
  otherField: 'untouched',
});

describe('applyPolicyChoice', () => {
  it('defaults keep the flavor as-is', () => {
    const t = applyPolicyChoice(base());
    assert.equal(t.royaltyPolicy, LAP);
    assert.equal(t.derivativesReciprocal, true);
    assert.equal(t.otherField, 'untouched');
  });

  it('LRP swaps the royalty policy address', () => {
    const t = applyPolicyChoice(base(), 'LRP');
    assert.equal(t.royaltyPolicy, LRP);
    assert.equal(t.derivativesReciprocal, true);
  });

  it('explicit LAP keeps the LAP address', () => {
    assert.equal(applyPolicyChoice(base(), 'LAP').royaltyPolicy, LAP);
  });

  it('reciprocal=false detaches the subtree from forced terms', () => {
    const t = applyPolicyChoice(base(), 'LRP', false);
    assert.equal(t.royaltyPolicy, LRP);
    assert.equal(t.derivativesReciprocal, false);
  });

  it('does not mutate the input object', () => {
    const input = base();
    applyPolicyChoice(input, 'LRP', false);
    assert.equal(input.royaltyPolicy, LAP);
    assert.equal(input.derivativesReciprocal, true);
  });
});
