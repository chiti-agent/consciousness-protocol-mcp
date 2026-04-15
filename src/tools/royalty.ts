/**
 * Royalty tools — pay royalties and claim revenue.
 */

import type { Config } from '../config/store.js';
import { loadKey, REGISTRATIONS_FILE } from '../config/store.js';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Contract addresses on Story Protocol (Aeneid testnet + mainnet).
 */
const ROYALTY_MODULE = '0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086';
const WIP_TOKEN = '0x1514000000000000000000000000000000000000';
const ROYALTY_POLICY_LAP = '0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E';

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

const VAULT_ABI = [
  {
    inputs: [],
    name: 'getCurrentSnapshotId',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'snapshotId', type: 'uint256' },
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

const LAP_ABI = [{
  inputs: [
    { name: 'ipId', type: 'address' },
    { name: 'ancestorIpId', type: 'address' },
    { name: 'token', type: 'address' },
  ],
  name: 'getTransferredTokens',
  outputs: [{ type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

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
function findDirectChildren(registrations: Registration[], parentIpId: string): Registration[] {
  return registrations.filter(
    (r) => r.success && r.parentIpId === parentIpId && r.ipId,
  );
}

/** Recursively find all descendants (children, grandchildren, ...) for display. */
function findAllDescendants(registrations: Registration[], parentIpId: string): Registration[] {
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
function resolveVolemApiUrl(config: Config): string {
  return config.volemApiUrl ?? process.env.VOLEM_API_URL ?? 'http://localhost:3010';
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

      // Snapshot-based claimable
      let claimable = BigInt(0);
      const snapshotClaimablePromise = (async () => {
        try {
          const snapshotId = await publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'getCurrentSnapshotId',
          }) as bigint;
          if (snapshotId > BigInt(0)) {
            claimable = await publicClient.readContract({
              address: vaultAddress,
              abi: VAULT_ABI,
              functionName: 'claimableRevenue',
              args: [ipId, snapshotId, WIP_TOKEN as Address],
            }) as bigint;
          }
        } catch {
          // No snapshot yet — claimable stays 0
        }
      })();

      const [totalReceived, vaultBalance] = await Promise.all([
        totalReceivedPromise,
        vaultBalancePromise,
        snapshotClaimablePromise,
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
        // When using Volem API we don't have rev share % inline — default to 10%.
        // The on-chain LAP contract enforces the actual percentage regardless of
        // what we display here; this is only used for the estimated pending calc.
        const revenueSharePct = await getRevShareForIp(publicClient, childIpId as `0x${string}`) ?? 10;
        const revShareBps = Math.round(revenueSharePct * 100); // basis points (integer-safe for BigInt)

        try {
          const [childRevenue, transferred] = await Promise.all([
            publicClient.readContract({
              address: ROYALTY_MODULE as Address,
              abi: ROYALTY_MODULE_ABI,
              functionName: 'totalRevenueTokensReceived',
              args: [childIpId as Address, WIP_TOKEN as Address],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: ROYALTY_POLICY_LAP as Address,
              abi: LAP_ABI,
              functionName: 'getTransferredTokens',
              args: [childIpId as Address, ipId, WIP_TOKEN as Address],
            }) as Promise<bigint>,
          ]);

          // Expected revenue share based on actual percentage from license terms
          const expected = childRevenue * BigInt(revShareBps) / BigInt(10000);
          const pending = expected > transferred ? expected - transferred : BigInt(0);

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
      // mintingFeeEarned = total received minus rev share already transferred in
      const mintingFeeEarned = totalReceived > revenueShareTransferred
        ? totalReceived - revenueShareTransferred
        : totalReceived;
      // claimableNow = vault claimable (from snapshot) + pending rev share from direct children
      const claimableNow = claimable + revenueSharePending;
      // totalEarned = minting fees + all revenue share (received + pending)
      const totalEarned = mintingFeeEarned + revenueShareTransferred + revenueSharePending;

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
        transport: http(config.story.rpcUrl),
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
      const { http, formatEther } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: http(config.story.rpcUrl),
        chainId: config.story.chainId,
      });

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
      const claimed: Array<{ ipId: string; amount: string; txHash: string }> = [];
      const errors: Array<{ ipId: string; error: string }> = [];
      let totalClaimedWei = BigInt(0);

      for (const ipId of ipIds) {
        try {
          // Find DIRECT children only — Story Protocol LAP limitation
          const directChildIds = await fetchDerivatives(ipId, false, volemApiUrl);
          const childIpIds: Address[] = directChildIds.map((id) => id as Address);
          const royaltyPolicies = childIpIds.map(() => ROYALTY_POLICY_LAP as Address);

          const result = await Promise.race([
            client.royalty.claimAllRevenue({
              ancestorIpId: ipId as Address,
              claimer: ipId as Address,
              currencyTokens: [WIP_TOKEN_ADDRESS],
              childIpIds,
              royaltyPolicies,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
          ]);

          if (result.claimedTokens && result.claimedTokens.length > 0) {
            const txHash = result.txHashes?.[0] ?? '';
            for (const ct of result.claimedTokens) {
              const rawAmount = (ct as any).amount ?? BigInt(0);
              const amountBigInt = typeof rawAmount === 'bigint' ? rawAmount : BigInt(String(rawAmount));
              if (amountBigInt > BigInt(0)) {
                totalClaimedWei += amountBigInt;
                claimed.push({
                  ipId,
                  amount: formatEther(amountBigInt),
                  txHash,
                });
              }
            }
          }
        } catch (err: any) {
          const msg = err.message || String(err);
          // Skip expected "no vault" / "no revenue" errors, but log unexpected ones
          if (!msg.includes('vault') && !msg.includes('revenue') && !msg.includes('IpRoyaltyVault__NoClaimableTokens')) {
            errors.push({ ipId, error: msg });
          }
        }
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
