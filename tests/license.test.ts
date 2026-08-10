import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { prepareMintLicenseRequest, type MintLicenseParams } from '../src/tools/license.js';

type Address = `0x${string}`;

const IP_ID = '0x1111111111111111111111111111111111111111' as Address;
const WALLET = '0x2222222222222222222222222222222222222222' as Address;
const RECEIVER = '0x3333333333333333333333333333333333333333' as Address;
const CURRENCY = '0x4444444444444444444444444444444444444444' as Address;

function params(overrides: Partial<MintLicenseParams> = {}): MintLicenseParams {
  return {
    ip_id: IP_ID,
    license_terms_id: '42',
    amount: 2,
    ...overrides,
  };
}

function predictor(tokenAmount: bigint) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async predictMintingLicenseFee(request: Record<string, unknown>) {
      calls.push(request);
      return { currencyToken: CURRENCY, tokenAmount };
    },
  };
}

describe('prepareMintLicenseRequest', () => {
  it('uses the exact total on-chain quote as the implicit fee cap', async () => {
    const license = predictor(parseEther('0.02'));
    const prepared = await prepareMintLicenseRequest(license, params(), WALLET);

    assert.deepEqual(license.calls, [{
      licensorIpId: IP_ID,
      licenseTermsId: 42n,
      amount: 2,
      receiver: WALLET,
    }]);
    assert.equal(prepared.request.maxMintingFee, parseEther('0.02'));
    assert.equal(prepared.request.maxRevenueShare, 100);
    assert.equal(prepared.quote.currencyToken, CURRENCY);
  });

  it('uses an explicit receiver and total batch cap', async () => {
    const license = predictor(parseEther('0.02'));
    const prepared = await prepareMintLicenseRequest(
      license,
      params({ receiver: RECEIVER, max_minting_fee: '0.03' }),
      WALLET,
    );

    assert.equal(license.calls[0].receiver, RECEIVER);
    assert.equal(prepared.request.receiver, RECEIVER);
    assert.equal(prepared.request.maxMintingFee, parseEther('0.03'));
  });

  it('rejects a quote above the explicit cap before minting', async () => {
    const license = predictor(parseEther('0.03'));

    await assert.rejects(
      prepareMintLicenseRequest(license, params({ max_minting_fee: '0.02' }), WALLET),
      /exceeds max_minting_fee 0\.02; mint aborted before transaction/,
    );
  });

  it('maps a zero quote and zero user cap to the strictest nonzero guard', async () => {
    for (const max_minting_fee of [undefined, '0']) {
      const prepared = await prepareMintLicenseRequest(
        predictor(0n),
        params({ max_minting_fee }),
        WALLET,
      );
      assert.equal(prepared.request.maxMintingFee, 1n);
    }
  });

  it('fails closed for invalid fee strings and receiver addresses', async () => {
    for (const max_minting_fee of ['-1', '1e3', '0.1234567890123456789']) {
      await assert.rejects(
        prepareMintLicenseRequest(predictor(0n), params({ max_minting_fee }), WALLET),
        /Invalid max_minting_fee/,
      );
    }
    await assert.rejects(
      prepareMintLicenseRequest(predictor(0n), params({ receiver: 'not-an-address' }), WALLET),
      /Invalid receiver/,
    );
  });

  it('fails closed when the on-chain prediction fails', async () => {
    const license = {
      async predictMintingLicenseFee() {
        throw new Error('RPC unavailable');
      },
    };

    await assert.rejects(prepareMintLicenseRequest(license, params(), WALLET), /RPC unavailable/);
  });
});
