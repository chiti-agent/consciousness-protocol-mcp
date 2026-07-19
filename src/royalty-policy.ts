/** Canonical per-policy reads shared by royalty reporting and claim filtering. */

import type { Address, PublicClient } from 'viem';

export const ROYALTY_MODULE = '0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086' as Address;
export const ROYALTY_POLICY_LAP = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E' as Address;
export const ROYALTY_POLICY_LRP = '0x9156e603C949481883B1d3355c6f1132D191fC41' as Address;

const ROYALTY_ACCOUNTING_ABI = [{
  inputs: [
    { name: 'ipId', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'royaltyPolicy', type: 'address' },
  ],
  name: 'totalRevenueTokensAccounted',
  outputs: [{ type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

// Shared by RoyaltyPolicyLAP and RoyaltyPolicyLRP (IGraphAwareRoyaltyPolicy).
// getPolicyRoyalty is declared non-view on LRP but reads safely via eth_call.
export const POLICY_ABI = [
  {
    inputs: [
      { name: 'ipId', type: 'address' },
      { name: 'ancestorIpId', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    name: 'getTransferredTokens',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'ipId', type: 'address' },
      { name: 'ancestorIpId', type: 'address' },
    ],
    name: 'getPolicyRoyalty',
    outputs: [{ type: 'uint32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'ipId', type: 'address' }],
    name: 'getPolicyRoyaltyStack',
    outputs: [{ type: 'uint32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export type PolicyAccounting = {
  accountedRevenue: bigint;
  transferred: bigint;
  policyPct: number;
  stackPct: number;
};

export async function readPolicyAccounting(
  publicClient: PublicClient,
  childIpId: Address,
  ancestorIpId: Address,
  token: Address,
  policy: Address,
): Promise<PolicyAccounting> {
  const isLrp = policy.toLowerCase() === ROYALTY_POLICY_LRP.toLowerCase();
  const [accountedRevenue, transferred, policyPct, stackPct] = await Promise.all([
    publicClient.readContract({
      address: ROYALTY_MODULE,
      abi: ROYALTY_ACCOUNTING_ABI,
      functionName: 'totalRevenueTokensAccounted',
      args: [childIpId, token, policy],
    }),
    publicClient.readContract({
      address: policy,
      abi: POLICY_ABI,
      functionName: 'getTransferredTokens',
      args: [childIpId, ancestorIpId, token],
    }),
    publicClient.readContract({
      address: policy,
      abi: POLICY_ABI,
      functionName: 'getPolicyRoyalty',
      args: [childIpId, ancestorIpId],
    }).then(Number),
    isLrp
      ? publicClient.readContract({
          address: policy,
          abi: POLICY_ABI,
          functionName: 'getPolicyRoyaltyStack',
          args: [ancestorIpId],
        }).then(Number)
      : Promise.resolve(0),
  ]);

  return { accountedRevenue, transferred, policyPct, stackPct };
}
