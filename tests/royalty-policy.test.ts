import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, PublicClient } from 'viem';
import {
  ROYALTY_MODULE,
  ROYALTY_POLICY_LAP,
  ROYALTY_POLICY_LRP,
  readPolicyAccounting,
} from '../src/royalty-policy.js';

const child = '0x1111111111111111111111111111111111111111' as Address;
const ancestor = '0x2222222222222222222222222222222222222222' as Address;
const token = '0x3333333333333333333333333333333333333333' as Address;

function mockClient(
  implementation: (request: { address: Address; functionName: string; args: readonly unknown[] }) => Promise<unknown>,
): PublicClient {
  return { readContract: implementation } as unknown as PublicClient;
}

describe('readPolicyAccounting', () => {
  it('uses the exact policy-accounted revenue bucket for LAP', async () => {
    const calls: Array<{ address: Address; functionName: string; args: readonly unknown[] }> = [];
    const client = mockClient(async (request) => {
      calls.push(request);
      if (request.functionName === 'totalRevenueTokensAccounted') return 1_000n;
      if (request.functionName === 'getTransferredTokens') return 25n;
      if (request.functionName === 'getPolicyRoyalty') return 10_000_000;
      throw new Error(`Unexpected read ${request.functionName}`);
    });

    const result = await readPolicyAccounting(client, child, ancestor, token, ROYALTY_POLICY_LAP);

    assert.deepEqual(result, {
      accountedRevenue: 1_000n,
      transferred: 25n,
      policyPct: 10_000_000,
      stackPct: 0,
    });
    assert.ok(calls.some((call) =>
      call.address === ROYALTY_MODULE
      && call.functionName === 'totalRevenueTokensAccounted'
      && call.args[0] === child
      && call.args[1] === token
      && call.args[2] === ROYALTY_POLICY_LAP));
    assert.ok(!calls.some((call) => call.functionName === 'totalRevenueTokensReceived'));
    assert.ok(!calls.some((call) => call.functionName === 'getPolicyRoyaltyStack'));
  });

  it('reads the ancestor stack only for LRP', async () => {
    const calls: string[] = [];
    const client = mockClient(async (request) => {
      calls.push(request.functionName);
      if (request.functionName === 'totalRevenueTokensAccounted') return 900n;
      if (request.functionName === 'getTransferredTokens') return 10n;
      if (request.functionName === 'getPolicyRoyalty') return 10_000_000;
      if (request.functionName === 'getPolicyRoyaltyStack') return 20_000_000;
      throw new Error(`Unexpected read ${request.functionName}`);
    });

    const result = await readPolicyAccounting(client, child, ancestor, token, ROYALTY_POLICY_LRP);

    assert.deepEqual(result, {
      accountedRevenue: 900n,
      transferred: 10n,
      policyPct: 10_000_000,
      stackPct: 20_000_000,
    });
    assert.ok(calls.includes('getPolicyRoyaltyStack'));
  });
});
