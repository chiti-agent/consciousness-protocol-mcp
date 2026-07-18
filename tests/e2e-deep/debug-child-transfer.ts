/**
 * Debug: why does claimAllRevenue revert when childIpIds are included?
 * Simulates the raw RoyaltyWorkflows call for ROOT with the full child set,
 * then bisects child-by-child to find the reverting pair and decodes the error
 * against the full workflows ABI.
 *
 * Run: node --import tsx/esm tests/e2e-deep/debug-child-transfer.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { parseAbi, keccak256, toHex } from 'viem';

const workflowsAbi = parseAbi([
  'function claimAllRevenue(address ancestorIpId, address claimer, address[] childIpIds, address[] royaltyPolicies, address[] currencyTokens) returns (uint256[] amountsClaimed)',
]);

// Candidate custom errors from story protocol-core — match by selector
const ERROR_SIGS = [
  'RoyaltyPolicyLAP__ExceedsClaimableRoyalty()',
  'RoyaltyPolicyLAP__ZeroClaimableRoyalty()',
  'RoyaltyPolicyLAP__ClaimerNotAnAncestor()',
  'RoyaltyPolicyLAP__SameIpTransfer()',
  'RoyaltyPolicyLAP__InvalidTargetIpId()',
  'IpRoyaltyVault__NoClaimableTokens()',
  'IpRoyaltyVault__ClaimerNotAnAncestor()',
  'IpRoyaltyVault__InvalidTargetIpId()',
  'IpRoyaltyVault__VaultsMustClaimAsSelf()',
  'IpRoyaltyVault__VaultDoesNotBelongToAnAncestor()',
  'RoyaltyModule__ZeroAmount()',
  'RoyaltyModule__NotAllowedCaller()',
  'RoyaltyWorkflows__NoRoyaltyTokensToClaim()',
  'InsufficientAllowance()',
  'ERC20InsufficientAllowance(address,uint256,uint256)',
  'ERC20InsufficientBalance(address,uint256,uint256)',
];
const SELECTOR_MAP = new Map(ERROR_SIGS.map((s) => [keccak256(toHex(s)).slice(0, 10), s]));

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));

const RPC = 'https://aeneid.storyrpc.io';
const WORKFLOWS = '0x9515faE61E0c0447C6AC6dEe5628A2097aFE1890' as const;
const LAP = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E' as const;
const WIP = '0x1514000000000000000000000000000000000000' as const;

const pub = createPublicClient({ transport: http(RPC) });

const ROOT = state.ROOT.ipId as `0x${string}`;
const CHILDREN: Array<[string, `0x${string}`]> = [
  ['L1a', state.L1a.ipId],
  ['L2a', state.L2a.ipId],
  ['L3', state.L3.ipId],
  ['L4', state.L4.ipId],
  ['L5', state.L5.ipId],
  ['L6', state.L6.ipId],
];

async function sim(label: string, children: `0x${string}`[]) {
  try {
    const res = await pub.simulateContract({
      address: WORKFLOWS,
      abi: workflowsAbi,
      functionName: 'claimAllRevenue',
      args: [ROOT, ROOT, children, children.map(() => LAP), [WIP]],
      account: ROOT,
    });
    const amounts = (res.result as readonly bigint[]).map((v) => Number(v) / 1e18);
    console.log(`${label.padEnd(28)} OK  amounts=${JSON.stringify(amounts)}`);
    return true;
  } catch (e: any) {
    let raw = '';
    for (let c = e; c; c = c.cause) {
      if (typeof c.data === 'string' && c.data.startsWith('0x')) { raw = c.data; break; }
      if (typeof c.data?.data === 'string') { raw = c.data.data; break; }
    }
    const selector = raw.slice(0, 10);
    const known = SELECTOR_MAP.get(selector);
    const full = String(e.shortMessage ?? e.message).replace(/\s+/g, ' ').slice(0, 260);
    console.log(`${label.padEnd(28)} REVERT  selector=${selector || '?'}  known=${known ?? '-'}  msg=${full}`);
    return false;
  }
}

async function simTokensPerChild(label: string, children: `0x${string}`[]) {
  try {
    const res = await pub.simulateContract({
      address: WORKFLOWS,
      abi: workflowsAbi,
      functionName: 'claimAllRevenue',
      args: [ROOT, ROOT, children, children.map(() => LAP), children.map(() => WIP)],
      account: ROOT,
    });
    const amounts = (res.result as readonly bigint[]).map((v) => Number(v) / 1e18);
    console.log(`${label.padEnd(28)} OK  amounts=${JSON.stringify(amounts)}`);
  } catch (e: any) {
    console.log(`${label.padEnd(28)} REVERT  ${String(e.shortMessage ?? e.message).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

console.log('ROOT =', ROOT, '\n');
await simTokensPerChild('FIX: tokens per child (6)', CHILDREN.map(([, a]) => a));
await sim('full set (6 children)', CHILDREN.map(([, a]) => a));
await sim('no children (self only)', []);
for (const [key, addr] of CHILDREN) {
  await sim(`only ${key}`, [addr]);
}
