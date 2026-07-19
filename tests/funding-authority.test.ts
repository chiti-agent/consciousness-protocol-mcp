import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMainFundingKey } from './wallets/funding-authority.js';

describe('test-wallet funding authority', () => {
  it('is faucet-only unless MAIN_WALLET_KEY is supplied explicitly', () => {
    assert.equal(resolveMainFundingKey({}), undefined);
  });

  it('uses only the explicit MAIN_WALLET_KEY value', () => {
    const key = `0x${'22'.repeat(32)}`;
    assert.equal(resolveMainFundingKey({ MAIN_WALLET_KEY: key }), key);
  });
});
