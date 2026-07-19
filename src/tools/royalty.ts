/**
 * Royalty tools — pay royalties and claim revenue.
 */

import type { Config } from '../config/store.js';
import { loadKey, REGISTRATIONS_FILE } from '../config/store.js';
import { cappedHttp } from '../config/fee-cap.js';
import { postVolemEvent } from '../volem-events.js';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Contract addresses on Story Protocol (Aeneid testnet + mainnet).
 */
const ROYALTY_MODULE = '0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086';
const WIP_TOKEN = '0x1514000000000000000000000000000000000000';
const ROYALTY_POLICY_LAP = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E';
const ROYALTY_POLICY_LRP = '0x9156e603C949481883B1d3355c6f1132D191fC41';

const PIL = '0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316';
const LICENSE_REGISTRY = '0x529a750E02d8E2f15649c13D69a465286a780e24';

const PIL_ABI = [{
  name: 'getLicenseTerms',
  type: 'function' as const,
  inputs: [{ name: 'selectedLicenseTermsId', type: 'uint256' as const }],
  outputs: [{ name: '', type: 'tuple' as const, components: [
    { name: 'transferable', type: 'bool' as const },
    { name: 'royaltyPolicy', type: 'address' as const },
    { name: 'defaultMintingFee', type: 'uint256' as const },
    { name: 'expiration', type: 'uint256' as const },
    { name: 'commercialUse', type: 'bool' as const },
    { name: 'commercialAttribution', type: 'bool' as const },
    { name: 'commercializerChecker', type: 'address' as const },
    { name: 'commercializerCheckerData', type: 'bytes' as const },
    { name: 'commercialRevShare', type: 'uint32' as const },
    { name: 'commercialRevCeiling', type: 'uint256' as const },
    { name: 'derivativesAllowed', type: 'bool' as const },
    { name: 'derivativesAttribution', type: 'bool' as const },
    { name: 'derivativesApproval', type: 'bool' as const },
    { name: 'derivativesReciprocal', type: 'bool' as const },
    { name: 'derivativeRevCeiling', type: 'uint256' as const },
    { name: 'currency', type: 'address' as const },
    { name: 'uri', type: 'string' as const },
  ]}],
  stateMutability: 'view' as const,
}] as const;

const LICENSE_REGISTRY_ABI = [
  {
    type: 'function' as const,
    name: 'getAttachedLicenseTermsCount',
    inputs: [{ name: 'ipId', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'getAttachedLicenseTerms',
    inputs: [
      { name: 'ipId', type: 'address' as const },
      { name: 'index', type: 'uint256' as const },
    ],
    outputs: [
      { name: 'licenseTemplate', type: 'address' as const },
      { name: 'licenseTermsId', type: 'uint256' as const },
    ],
    stateMutability: 'view' as const,
  },
] as const;

const ROYALTY_MODULE_ABI = [
  {
    inputs: [{ name: 'ipId', type: 'address' }],
    name: 'ipRoyaltyVaults',
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'ipId', type: 'address' }, { name: 'token', type: 'address' }],
    name: 'totalRevenueTokensReceived',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Deployed IpRoyaltyVault (SDK v1.4.4) uses an accumulator/debt model — there is
// NO snapshot mechanism. Claimable is read via the 2-arg claimableRevenue(claimer,
// token). The old snapshot ABI (getCurrentSnapshotId + 3-arg claimableRevenue)
// reverts on the current vault, which silently pinned reported claimable to 0.
const VAULT_ABI = [
  {
    inputs: [
      { name: 'claimer', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    name: 'claimableRevenue',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const WIP_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Shared by RoyaltyPolicyLAP and RoyaltyPolicyLRP (IGraphAwareRoyaltyPolicy).
// getPolicyRoyalty is declared non-view on LRP but reads fine via eth_call.
const POLICY_ABI = [
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

type Registration = {
  success?: boolean;
  ipId?: string;
  parentIpId?: string;
  revenueShare?: number;
  title?: string;
  [key: string]: unknown;
};

/** Load registrations from the local JSON file. */
function loadRegistrations(): Registration[] {
  if (!existsSync(REGISTRATIONS_FILE)) return [];
  return JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
}

/** Fetch ALL IPs owned by the wallet from Story Protocol API (paginated). Falls back to registrations.json. */
async function fetchAllOwnIps(config: Config): Promise<Array<{ ipId: string; title: string }>> {
  const apiKey = config.storyApiKey;
  const ownerAddress = config.story.evmAddress;

  if (apiKey && ownerAddress) {
    try {
      const baseUrl = 'https://api.storyapis.com';
      const allIps: Array<{ ipId: string; title: string }> = [];
      let offset = 0;
      const pageSize = 100;

      while (true) {
        const res = await fetch(`${baseUrl}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
          body: JSON.stringify({
            where: { ownerAddress },
            orderBy: 'createdAt',
            orderDirection: 'desc',
            pagination: { limit: pageSize, offset },
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) break;

        const data = await res.json() as { data?: Array<{ id: string; title?: string }> };
        const page = data.data ?? [];
        if (page.length === 0) break;

        for (const a of page) {
          allIps.push({ ipId: a.id, title: a.title ?? `IP ${a.id.slice(0, 10)}` });
        }

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      if (allIps.length > 0) return allIps;
    } catch {
      // fall through to registrations.json
    }
  }

  // Fallback: local registrations
  const regs = loadRegistrations();
  return regs
    .filter((r) => r.success && r.ipId)
    .map((r) => ({ ipId: r.ipId as string, title: r.title ?? `IP ${r.ipId!.slice(0, 10)}` }));
}

/** Find direct children of a given IP from registrations. */
export function findDirectChildren(registrations: Registration[], parentIpId: string): Registration[] {
  return registrations.filter(
    (r) => r.success && r.parentIpId === parentIpId && r.ipId,
  );
}

/** Recursively find all descendants (children, grandchildren, ...) for display. */
export function findAllDescendants(registrations: Registration[], parentIpId: string): Registration[] {
  const directChildren = findDirectChildren(registrations, parentIpId);
  const allDescendants: Registration[] = [...directChildren];
  for (const child of directChildren) {
    if (child.ipId) {
      allDescendants.push(...findAllDescendants(registrations, child.ipId));
    }
  }
  return allDescendants;
}

/** File-based fallback for derivative discovery (uses registrations.json). */
function findChildrenFromFile(ipId: string, recursive: boolean): string[] {
  const registrations = loadRegistrations();
  if (recursive) {
    return findAllDescendants(registrations, ipId)
      .map((r) => r.ipId)
      .filter((id): id is string => !!id);
  }
  return findDirectChildren(registrations, ipId)
    .map((r) => r.ipId)
    .filter((id): id is string => !!id);
}

/** Resolve Volem API base URL from config, env, or default. */
export function resolveVolemApiUrl(config: Config): string {
  return config.volemApiUrl ?? process.env.VOLEM_API_URL ?? 'http://localhost:3010';
}

/** Per-child royalty-share math. revSharePct is a percentage (e.g. 10 for 10%). */
export function computeChildRevShare(
  childRevenue: bigint,
  transferred: bigint,
  revSharePct: number,
): { expected: bigint; pending: bigint } {
  const revShareBps = Math.round(revSharePct * 100); // basis points, integer-safe for BigInt
  const expected = (childRevenue * BigInt(revShareBps)) / BigInt(10000);
  const pending = expected > transferred ? expected - transferred : BigInt(0);
  return { expected, pending };
}

/**
 * Exact per-child pending math mirroring the policy contracts' transferToVault:
 *   max = childRevenue × policyPct / 10^8
 *   max -= max × ancestorStackPct / 10^8   (LRP only: my own ancestors' cut)
 *   pending = max − transferred
 * policyPct comes from getPolicyRoyalty(child, me) — for LAP it is the flat
 * share at any depth, for LRP it already encodes the multiplicative decay.
 * Scale: 10^8 = 100% (maxPercent).
 */
export function computePolicyPending(
  childRevenue: bigint,
  policyPct: number,
  ancestorStackPct: number,
  transferred: bigint,
): { expected: bigint; pending: bigint } {
  const MAX_PCT = BigInt(100_000_000);
  let expected = (childRevenue * BigInt(policyPct)) / MAX_PCT;
  expected -= (expected * BigInt(ancestorStackPct)) / MAX_PCT;
  const pending = expected > transferred ? expected - transferred : BigInt(0);
  return { expected, pending };
}

/** Aggregate financial summary for an IP's revenue. All values in wei (bigint). */
export function computeFinancialSummary(input: {
  totalReceived: bigint;
  claimable: bigint;
  revenueShareTransferred: bigint;
  revenueSharePending: bigint;
}): { mintingFeeEarned: bigint; claimableNow: bigint; totalEarned: bigint } {
  const { totalReceived, claimable, revenueShareTransferred, revenueSharePending } = input;
  const mintingFeeEarned =
    totalReceived > revenueShareTransferred ? totalReceived - revenueShareTransferred : totalReceived;
  const claimableNow = claimable + revenueSharePending;
  const totalEarned = mintingFeeEarned + revenueShareTransferred + revenueSharePending;
  return { mintingFeeEarned, claimableNow, totalEarned };
}

/**
 * Fetch derivative IP IDs from Volem API, falling back to registrations.json
 * if the API is unavailable.
 */
async function fetchDerivatives(
  ipId: string,
  recursive: boolean,
  volemApiUrl: string,
): Promise<string[]> {
  try {
    const url = `${volemApiUrl}/api/ip/${ipId}/derivatives${recursive ? '?recursive=true' : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return findChildrenFromFile(ipId, recursive);
    const data = await res.json();
    return data.success ? (data.ipIds ?? []) : findChildrenFromFile(ipId, recursive);
  } catch {
    // Volem unavailable — fall back to registrations.json
    return findChildrenFromFile(ipId, recursive);
  }
}

/**
 * Read the actual commercialRevShare % for an IP from on-chain license terms.
 * Returns the percentage as a number (e.g. 10 for 10%), or null if unreadable.
 */
async function getRevShareForIp(
  publicClient: any,
  ipId: `0x${string}`,
): Promise<number | null> {
  try {
    const termsCount = await publicClient.readContract({
      address: LICENSE_REGISTRY as `0x${string}`,
      abi: LICENSE_REGISTRY_ABI,
      functionName: 'getAttachedLicenseTermsCount',
      args: [ipId],
    }) as bigint;

    if (termsCount === 0n) return null;

    const [, licenseTermsId] = await publicClient.readContract({
      address: LICENSE_REGISTRY as `0x${string}`,
      abi: LICENSE_REGISTRY_ABI,
      functionName: 'getAttachedLicenseTerms',
      args: [ipId, 0n],
    }) as [string, bigint];

    const terms = await publicClient.readContract({
      address: PIL as `0x${string}`,
      abi: PIL_ABI,
      functionName: 'getLicenseTerms',
      args: [licenseTermsId],
    }) as any;

    return Number(terms.commercialRevShare) / 1_000_000;
  } catch {
    return null;
  }
}

/**
 * Read the royalty policy actually attached to an IP from its on-chain license
 * terms. Returns the policy address, or null if unreadable. claim() uses this so
 * each child is paired with its real policy instead of an assumed LAP — a
 * mismatched policy makes the whole atomic claimAllRevenue tx revert.
 */
async function getRoyaltyPolicyForIp(
  publicClient: any,
  ipId: `0x${string}`,
): Promise<`0x${string}` | null> {
  try {
    const termsCount = await publicClient.readContract({
      address: LICENSE_REGISTRY as `0x${string}`,
      abi: LICENSE_REGISTRY_ABI,
      functionName: 'getAttachedLicenseTermsCount',
      args: [ipId],
    }) as bigint;

    if (termsCount === 0n) return null;

    const [, licenseTermsId] = await publicClient.readContract({
      address: LICENSE_REGISTRY as `0x${string}`,
      abi: LICENSE_REGISTRY_ABI,
      functionName: 'getAttachedLicenseTerms',
      args: [ipId, 0n],
    }) as [string, bigint];

    const terms = await publicClient.readContract({
      address: PIL as `0x${string}`,
      abi: PIL_ABI,
      functionName: 'getLicenseTerms',
      args: [licenseTermsId],
    }) as any;

    const policy = terms.royaltyPolicy as `0x${string}`;
    if (!policy || policy === '0x0000000000000000000000000000000000000000') return null;
    return policy;
  } catch {
    return null;
  }
}

export const royaltyTool = {
  /**
   * Check revenue status for an IP asset — clear financial summary with
   * separate minting fee income vs revenue share income, plus claimable total.
   * Read-only, no gas cost.
   */
  async getRevenue(config: Config, params: { ip_id: string }) {
    try {
      const { createPublicClient, http, formatEther } = await import('viem');
      type Address = `0x${string}`;

      const publicClient = createPublicClient({
        transport: http(config.story.rpcUrl),
      });

      const ipId = params.ip_id as Address;

      // Get vault address
      const vaultAddress = await publicClient.readContract({
        address: ROYALTY_MODULE as Address,
        abi: ROYALTY_MODULE_ABI,
        functionName: 'ipRoyaltyVaults',
        args: [ipId],
      }) as Address;

      const hasVault = vaultAddress !== '0x0000000000000000000000000000000000000000';

      if (!hasVault) {
        return {
          success: true,
          ipId: params.ip_id,
          hasVault: false,
          message: 'No royalty vault exists for this IP. Vault is created when the first derivative mints a license.',
        };
      }

      // Fetch vault data in parallel: total received, claimable from snapshot, vault WIP balance
      const totalReceivedPromise = publicClient.readContract({
        address: ROYALTY_MODULE as Address,
        abi: ROYALTY_MODULE_ABI,
        functionName: 'totalRevenueTokensReceived',
        args: [ipId, WIP_TOKEN as Address],
      }) as Promise<bigint>;

      const vaultBalancePromise = publicClient.readContract({
        address: WIP_TOKEN as Address,
        abi: WIP_ABI,
        functionName: 'balanceOf',
        args: [vaultAddress],
      }) as Promise<bigint>;

      // Vault-claimable via the deployed accumulator model (2-arg
      // claimableRevenue(claimer, token)). This is what the ancestor can claim
      // from its own vault right now — including minting fees that arrived there.
      let claimable = BigInt(0);
      const claimablePromise = (async () => {
        try {
          claimable = await publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'claimableRevenue',
            args: [ipId, WIP_TOKEN as Address],
          }) as bigint;
        } catch {
          // Vault does not expose claimableRevenue(claimer, token) — claimable stays 0
        }
      })();

      const [totalReceived, vaultBalance] = await Promise.all([
        totalReceivedPromise,
        vaultBalancePromise,
        claimablePromise,
      ]);

      // --- Revenue share from children ---
      const volemApiUrl = resolveVolemApiUrl(config);
      const [directChildIpIds, allDescendantIpIds] = await Promise.all([
        fetchDerivatives(params.ip_id, false, volemApiUrl),
        fetchDerivatives(params.ip_id, true, volemApiUrl),
      ]);

      let revenueShareTransferred = BigInt(0);
      let revenueSharePending = BigInt(0);

      type ChildDetail = {
        childIpId: string;
        title: string;
        isDirect: boolean;
        revenueSharePct: number;
        childRevenue: string;
        transferred: string;
        pending: string;
      };
      const childDetails: ChildDetail[] = [];

      const directChildIdSet = new Set(directChildIpIds);

      for (const childIpId of allDescendantIpIds) {
        const isDirect = directChildIdSet.has(childIpId);

        try {
          // Each child settles through its own royalty policy contract — LAP
          // and LRP both track transfers and percentages, but with different
          // math (LAP: flat share at any depth; LRP: decay + ancestor-stack
          // deduction). Read everything from the child's actual policy.
          const childPolicy =
            (await getRoyaltyPolicyForIp(publicClient, childIpId as `0x${string}`)) ??
            (ROYALTY_POLICY_LAP as Address);
          const isLrpChild = childPolicy.toLowerCase() === ROYALTY_POLICY_LRP.toLowerCase();

          const [childRevenue, transferred, policyPct, stackPct] = await Promise.all([
            publicClient.readContract({
              address: ROYALTY_MODULE as Address,
              abi: ROYALTY_MODULE_ABI,
              functionName: 'totalRevenueTokensReceived',
              args: [childIpId as Address, WIP_TOKEN as Address],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: childPolicy,
              abi: POLICY_ABI,
              functionName: 'getTransferredTokens',
              args: [childIpId as Address, ipId, WIP_TOKEN as Address],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: childPolicy,
              abi: POLICY_ABI,
              functionName: 'getPolicyRoyalty',
              args: [childIpId as Address, ipId],
            }).then(Number) as Promise<number>,
            isLrpChild
              ? (publicClient.readContract({
                  address: childPolicy,
                  abi: POLICY_ABI,
                  functionName: 'getPolicyRoyaltyStack',
                  args: [ipId],
                }).then(Number) as Promise<number>)
              : Promise.resolve(0),
          ]);

          const revenueSharePct = policyPct / 1_000_000;
          const { pending } = computePolicyPending(childRevenue, policyPct, stackPct, transferred);

          revenueShareTransferred += transferred;
          revenueSharePending += pending;

          if (childRevenue > BigInt(0) || transferred > BigInt(0)) {
            childDetails.push({
              childIpId,
              title: 'unknown',
              isDirect,
              revenueSharePct,
              childRevenue: formatEther(childRevenue),
              transferred: formatEther(transferred),
              pending: formatEther(pending),
            });
          }
        } catch {
          // Skip children that can't be read
        }
      }

      // --- Financial summary ---
      const { mintingFeeEarned, claimableNow, totalEarned } = computeFinancialSummary({
        totalReceived,
        claimable,
        revenueShareTransferred,
        revenueSharePending,
      });

      return {
        success: true,
        ipId: params.ip_id,
        hasVault: true,
        vaultAddress,

        // Separate earnings breakdown
        mintingFeeEarned: formatEther(mintingFeeEarned),
        revenueShareReceived: formatEther(revenueShareTransferred),
        revenueShareClaimable: formatEther(revenueSharePending),
        totalEarned: formatEther(totalEarned),

        // What can be claimed RIGHT NOW
        claimableNow: formatEther(claimableNow),

        // Raw vault data for debugging
        vaultBalance: formatEther(vaultBalance),

        // Children details (for transparency)
        ...(childDetails.length > 0 && { children: childDetails }),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async pay(config: Config, params: { receiver_ip_id: string; amount: string }) {
    try {
      const { StoryClient, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http, parseEther, zeroAddress } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: cappedHttp(http, config.story.rpcUrl),
        chainId: config.story.chainId,
      });

      const result = await Promise.race([
        client.royalty.payRoyaltyOnBehalf({
          receiverIpId: params.receiver_ip_id as Address,
          payerIpId: zeroAddress,
          token: WIP_TOKEN_ADDRESS,
          amount: parseEther(params.amount),
          // Note: SDK handles IP→WIP wrapping internally
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      await postVolemEvent(config, {
        ip_id: params.receiver_ip_id,
        event_type: 'ROYALTY_PAID',
        tx_hash: result.txHash,
        metadata: { paidAmount: parseEther(params.amount).toString(), payer: account.address },
      });

      return {
        success: true,
        txHash: result.txHash,
        amount: params.amount,
        receiver: params.receiver_ip_id,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async claim(config: Config, params: { ip_id?: string }) {
    try {
      const { StoryClient, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { createPublicClient, http, formatEther } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: cappedHttp(http, config.story.rpcUrl),
        chainId: config.story.chainId,
      });
      const publicClient = createPublicClient({ transport: http(config.story.rpcUrl) });

      // Determine which IPs to claim from
      const registrations = loadRegistrations();
      let ipIds: string[] = [];
      if (params.ip_id) {
        ipIds = [params.ip_id];
      } else {
        ipIds = registrations
          .filter((r) => r.success && r.ipId)
          .map((r) => r.ipId as string);
      }

      if (ipIds.length === 0) {
        return { success: true, claimed: [], totalClaimed: '0', total_ips_checked: 0, message: 'No registered IPs found' };
      }

      const volemApiUrl = resolveVolemApiUrl(config);
      const claimed: Array<{ ipId: string; amount: string; amountWei: string; txHash: string }> = [];
      const errors: Array<{ ipId: string; error: string }> = [];
      let totalClaimedWei = BigInt(0);
      const claimTimeoutMessage = 'Story Protocol call timed out after 60s';
      const isNothingToClaim = (msg: string) => /NoClaimableTokens|nothing to claim|no claimable revenue/i.test(msg);
      const isTimeout = (msg: string) => msg.includes(claimTimeoutMessage);

      // Run one claimAllRevenue call and record any claimed WIP. Returns the wei
      // claimed for this ipId in this call. With disablePostSteps the SDK skips
      // its auto-transfer/auto-unwrap tail (which can revert with 0x7d844d43 and
      // take the whole claim down); the claimed WIP then lands in the ancestor
      // IP account and is swept to the wallet with an explicit transferErc20.
      const runClaimAndRecord = async (
        ipId: Address, children: Address[], policies: Address[], disablePostSteps = false,
      ): Promise<bigint> => {
        const result = await Promise.race([
          client.royalty.claimAllRevenue({
            ancestorIpId: ipId,
            claimer: ipId,
            // The contract pairs currencyTokens[i] with childIpIds[i]; a single
            // token entry with several children reverts with "Array index is
            // out of bounds", killing every multi-child claim.
            currencyTokens: children.length > 0
              ? children.map(() => WIP_TOKEN_ADDRESS)
              : [WIP_TOKEN_ADDRESS],
            childIpIds: children,
            royaltyPolicies: policies,
            ...(disablePostSteps && {
              claimOptions: {
                autoTransferAllClaimedTokensFromIp: false,
                autoUnwrapIpTokens: false,
              },
            }),
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(claimTimeoutMessage)), 60_000)),
        ]);
        let sum = BigInt(0);
        if (result.claimedTokens && result.claimedTokens.length > 0) {
          const txHash = result.txHashes?.[0] ?? '';
          for (const ct of result.claimedTokens) {
            const rawAmount = (ct as any).amount ?? BigInt(0);
            const amountBigInt = typeof rawAmount === 'bigint' ? rawAmount : BigInt(String(rawAmount));
            if (amountBigInt > BigInt(0)) {
              sum += amountBigInt;
              claimed.push({ ipId, amount: formatEther(amountBigInt), amountWei: amountBigInt.toString(), txHash });
            }
          }
        }
        if (disablePostSteps && sum > BigInt(0)) {
          // Sweep the claimed WIP out of the IP account. Failure here is not a
          // lost claim — the tokens sit safely in the IP account — so record a
          // warning instead of throwing.
          try {
            await client.ipAccount.transferErc20({
              ipId,
              tokens: [{ address: WIP_TOKEN as Address, amount: sum, target: account.address }],
            });
          } catch (err: any) {
            errors.push({ ipId, error: `sweep transferErc20 (WIP stays in IP account, retry later): ${err.message || String(err)}` });
          }
        }
        return sum;
      };

      // One claim attempt with an automatic post-step-disabled retry: an SDK
      // revert in the auto-transfer/unwrap tail must not cost us the claim.
      const claimWithPostStepFallback = async (
        ipId: Address, children: Address[], policies: Address[], label: string,
      ): Promise<{ sum: bigint; timedOut: boolean }> => {
        try {
          return { sum: await runClaimAndRecord(ipId, children, policies), timedOut: false };
        } catch (err: any) {
          const msg = err.message || String(err);
          if (isTimeout(msg)) return { sum: BigInt(0), timedOut: true };
          if (isNothingToClaim(msg)) return { sum: BigInt(0), timedOut: false };
          try {
            return { sum: await runClaimAndRecord(ipId, children, policies, true), timedOut: false };
          } catch (retryErr: any) {
            const retryMsg = retryErr.message || String(retryErr);
            if (!isNothingToClaim(retryMsg)) {
              errors.push({ ipId, error: `${label}: ${msg}; retry without post-steps: ${retryMsg}` });
            }
            return { sum: BigInt(0), timedOut: isTimeout(retryMsg) };
          }
        }
      };

      for (const ipId of ipIds) {
        try {
          const ip = ipId as Address;

          // Pre-check the ancestor's own accumulator vault. A drained vault is a
          // benign no-op, not an error for repeated claim_revenue calls.
          const vaultAddress = await publicClient.readContract({
            address: ROYALTY_MODULE as Address,
            abi: ROYALTY_MODULE_ABI,
            functionName: 'ipRoyaltyVaults',
            args: [ip],
          }) as Address;

          if (vaultAddress === '0x0000000000000000000000000000000000000000') continue;

          const selfClaimable = await publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'claimableRevenue',
            args: [ip, WIP_TOKEN as Address],
          }) as bigint;

          // Collect ALL descendants (direct + grandchildren + deeper). Include a
          // child only when it has an UNTRANSFERRED share for this ancestor
          // (policy math, mirrors transferToVault): claimAllRevenue reverts with
          // "Array index out of bounds" (0xa05b90b8) both for zero-revenue
          // children and for children whose share was already fully moved by an
          // earlier claim — one bad child kills the whole atomic batch.
          const descendantIds = await fetchDerivatives(ipId, true, volemApiUrl);
          const perChild = await Promise.all(
            descendantIds.map(async (id) => {
              const child = id as Address;
              try {
                const revenue = await publicClient.readContract({
                  address: ROYALTY_MODULE as Address,
                  abi: ROYALTY_MODULE_ABI,
                  functionName: 'totalRevenueTokensReceived',
                  args: [child, WIP_TOKEN as Address],
                }) as bigint;

                if (revenue <= BigInt(0)) return null;

                // Pair each child with its actual on-chain royalty policy, not a
                // hardcoded LAP: a mismatched policy makes claimAllRevenue revert
                // atomically, dropping the ancestor's own claim too.
                const policy = (await getRoyaltyPolicyForIp(publicClient, child)) ?? (ROYALTY_POLICY_LAP as Address);
                const isLrpChild = policy.toLowerCase() === ROYALTY_POLICY_LRP.toLowerCase();

                const [transferred, policyPct, stackPct] = await Promise.all([
                  publicClient.readContract({
                    address: policy,
                    abi: POLICY_ABI,
                    functionName: 'getTransferredTokens',
                    args: [child, ip, WIP_TOKEN as Address],
                  }) as Promise<bigint>,
                  publicClient.readContract({
                    address: policy,
                    abi: POLICY_ABI,
                    functionName: 'getPolicyRoyalty',
                    args: [child, ip],
                  }).then(Number) as Promise<number>,
                  isLrpChild
                    ? (publicClient.readContract({
                        address: policy,
                        abi: POLICY_ABI,
                        functionName: 'getPolicyRoyaltyStack',
                        args: [ip],
                      }).then(Number) as Promise<number>)
                    : Promise.resolve(0),
                ]);

                const { pending } = computePolicyPending(revenue, policyPct, stackPct, transferred);
                if (pending <= BigInt(0)) return null;

                return { child, policy };
              } catch (err: any) {
                // A read failure here drops the child from this claim — record
                // it so a skipped-but-owed child is diagnosable, not silent.
                errors.push({ ipId: child, error: `child share read failed, skipped: ${err.message || String(err)}` });
                return null;
              }
            }),
          );
          const claimableChildren = perChild.filter((entry): entry is { child: Address; policy: Address } => entry !== null);
          const childIpIds = claimableChildren.map((entry) => entry.child);
          const royaltyPolicies = claimableChildren.map((entry) => entry.policy);

          if (selfClaimable === BigInt(0) && childIpIds.length === 0) continue;

          // Attempt 1: full claim (child transfers + ancestor's own vault) in one
          // tx; on an SDK post-step revert it retries with post-steps disabled.
          const attempt1 = await claimWithPostStepFallback(
            ip, childIpIds, royaltyPolicies, `claimAllRevenue(with ${childIpIds.length} children)`,
          );
          let claimedHere = attempt1.sum;

          // Attempt 2 (fallback): if the full claim recovered nothing but this IP
          // has children, the child-transfer step likely reverted the atomic tx
          // and took the ancestor's own claimable (e.g. minting fees) down with it.
          // Retry a self-vault-only claim (no children) so those funds still land.
          if (claimedHere === BigInt(0) && !attempt1.timedOut && childIpIds.length > 0 && selfClaimable > BigInt(0)) {
            const attempt2 = await claimWithPostStepFallback(ip, [], [], 'claimAllRevenue(self-only)');
            claimedHere += attempt2.sum;
          }

          totalClaimedWei += claimedHere;
        } catch (err: any) {
          errors.push({ ipId, error: err.message || String(err) });
        }
      }

      // Dashboard's Total Claimed sums metadata.claimedAmount (wei) per event
      for (const entry of claimed) {
        await postVolemEvent(config, {
          ip_id: entry.ipId,
          event_type: 'ROYALTY_CLAIMED',
          tx_hash: entry.txHash,
          metadata: { claimedAmount: entry.amountWei },
        });
      }

      return {
        success: true,
        claimed,
        totalClaimed: formatEther(totalClaimedWei),
        total_ips_checked: ipIds.length,
        ...(errors.length > 0 && { errors }),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async getRevenueAll(config: Config) {
    try {
      const { createPublicClient, http, formatEther } = await import('viem');
      type Address = `0x${string}`;

      const publicClient = createPublicClient({
        transport: http(config.story.rpcUrl),
      });

      const ownIps = await fetchAllOwnIps(config);

      if (ownIps.length === 0) {
        return { success: true, assets: [], totals: { earned: '0', claimable: '0' }, message: 'No registered IPs found' };
      }

      type AssetRevenue = {
        ipId: string;
        title: string;
        hasVault: boolean;
        mintingFeeEarned: string;
        revenueShareReceived: string;
        revenueShareClaimable: string;
        totalEarned: string;
        claimableNow: string;
        childCount: number;
      };

      const assets: AssetRevenue[] = [];
      const errors: Array<{ ipId: string; error: string }> = [];
      let grandTotalEarned = BigInt(0);
      let grandTotalClaimable = BigInt(0);

      for (const { ipId, title } of ownIps) {
        try {
          const result = await this.getRevenue(config, { ip_id: ipId }) as any;
          if (result.success && result.hasVault) {
            const earned = BigInt(Math.round(parseFloat(result.totalEarned) * 1e18));
            const claimable = BigInt(Math.round(parseFloat(result.claimableNow) * 1e18));
            grandTotalEarned += earned;
            grandTotalClaimable += claimable;

            assets.push({
              ipId,
              title,
              hasVault: true,
              mintingFeeEarned: result.mintingFeeEarned,
              revenueShareReceived: result.revenueShareReceived,
              revenueShareClaimable: result.revenueShareClaimable,
              totalEarned: result.totalEarned,
              claimableNow: result.claimableNow,
              childCount: result.children?.length ?? 0,
            });
          } else {
            assets.push({
              ipId,
              title,
              hasVault: false,
              mintingFeeEarned: '0',
              revenueShareReceived: '0',
              revenueShareClaimable: '0',
              totalEarned: '0',
              claimableNow: '0',
              childCount: 0,
            });
          }
        } catch (err: any) {
          const msg = err.message || String(err);
          errors.push({ ipId, error: msg });
          assets.push({
            ipId,
            title,
            hasVault: false,
            mintingFeeEarned: '0',
            revenueShareReceived: '0',
            revenueShareClaimable: '0',
            totalEarned: '0',
            claimableNow: '0',
            childCount: 0,
          });
        }
      }

      return {
        success: true,
        totalAssets: ownIps.length,
        assetsWithVault: assets.filter((a) => a.hasVault).length,
        totals: {
          earned: formatEther(grandTotalEarned),
          claimable: formatEther(grandTotalClaimable),
        },
        assets,
        ...(errors.length > 0 && { errors }),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
