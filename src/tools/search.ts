/**
 * Search and list registered IP assets.
 *
 * Two sources:
 * 1. Local registrations.json — works registered by this agent (fast, complete metadata)
 * 2. Storyscan (Blockscout) API — all works on the SPG NFT contract (slower, needs IPFS fetch)
 */

import type { Config } from '../config/store.js';
import { REGISTRATIONS_FILE } from '../config/store.js';
import { existsSync, readFileSync } from 'node:fs';

interface Registration {
  ipId: string;
  tokenId: string;
  title: string;
  type: string;
  license: string;
  revenueShare: number;
  contentHash: string;
  ipfsUri: string;
  explorerUrl: string;
  registeredAt: string;
  parentIpId?: string;
  nearAccount?: string;
  chainSequence?: number;
  chainHash?: string;
}

interface SearchResult {
  total: number;
  works: Array<{
    ipId: string;
    title: string;
    type: string;
    license: string;
    revenueShare: number;
    registeredAt: string;
    explorerUrl: string;
    parentIpId?: string;
    source: 'local' | 'chain';
  }>;
}

function loadRegistrations(): Registration[] {
  if (!existsSync(REGISTRATIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

export const searchTool = {
  /**
   * List all works registered by this agent (from local registrations.json).
   */
  listOwn(filter?: { type?: string; license?: string }): SearchResult {
    let regs = loadRegistrations();

    if (filter?.type) {
      regs = regs.filter(r => r.type === filter.type);
    }
    if (filter?.license) {
      regs = regs.filter(r => r.license === filter.license);
    }

    return {
      total: regs.length,
      works: regs.map(r => ({
        ipId: r.ipId,
        title: r.title,
        type: r.type,
        license: r.license,
        revenueShare: r.revenueShare,
        registeredAt: r.registeredAt,
        explorerUrl: r.explorerUrl,
        parentIpId: r.parentIpId,
        source: 'local' as const,
      })),
    };
  },

  /**
   * Search works on Story Protocol via Storyscan (Blockscout) API.
   * Queries token transfers on the SPG NFT contract.
   */
  async searchOnChain(
    config: Config,
    params: { creator?: string; limit?: number },
  ): Promise<SearchResult> {
    const spgContract = config.story.spgNftContract;
    if (!spgContract) {
      return { total: 0, works: [] };
    }

    const baseUrl = config.story.chainId === 'aeneid'
      ? 'https://aeneid.storyscan.xyz/api/v2'
      : 'https://www.storyscan.io/api/v2';

    const limit = params.limit ?? 20;

    // If creator specified, search their token transfers
    // Otherwise, list recent tokens on the SPG contract
    const endpoint = params.creator
      ? `${baseUrl}/addresses/${params.creator}/token-transfers?type=ERC-721&limit=${limit}`
      : `${baseUrl}/tokens/${spgContract}/transfers?limit=${limit}`;

    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        return { total: 0, works: [] };
      }

      const data = await res.json() as {
        items?: Array<{
          token?: { address?: string };
          total?: { token_id?: string };
          to?: { hash?: string };
          from?: { hash?: string };
          timestamp?: string;
        }>;
      };

      const items = data.items ?? [];
      const works: SearchResult['works'] = [];

      for (const item of items) {
        const tokenId = item.total?.token_id;
        if (!tokenId) continue;

        // Try to find in local registrations for metadata
        const regs = loadRegistrations();
        const localMatch = regs.find(r => r.tokenId === tokenId);

        const explorerBase = config.story.chainId === 'aeneid'
          ? 'https://aeneid.explorer.story.foundation/ipa'
          : 'https://explorer.story.foundation/ipa';

        works.push({
          ipId: localMatch?.ipId ?? `token:${tokenId}`,
          title: localMatch?.title ?? `IP Asset #${tokenId}`,
          type: localMatch?.type ?? 'unknown',
          license: localMatch?.license ?? 'unknown',
          revenueShare: localMatch?.revenueShare ?? 0,
          registeredAt: localMatch?.registeredAt ?? item.timestamp ?? '',
          explorerUrl: localMatch?.explorerUrl ?? `${explorerBase}/${item.to?.hash ?? ''}`,
          parentIpId: localMatch?.parentIpId,
          source: localMatch ? 'local' : 'chain',
        });
      }

      return { total: works.length, works };
    } catch (err) {
      return { total: 0, works: [] };
    }
  },

  /**
   * Get detailed info about a specific IP asset by fetching its IPFS metadata.
   */
  async getAssetDetails(
    config: Config,
    ipId: string,
  ): Promise<object> {
    // Check local registrations first
    const regs = loadRegistrations();
    const local = regs.find(r => r.ipId?.toLowerCase() === ipId.toLowerCase());

    let ipfsMetadata: object | null = null;

    if (local?.ipfsUri) {
      const gateway = local.ipfsUri.replace('ipfs://', config.ipfs.gateway ?? 'https://gateway.pinata.cloud/ipfs/');
      try {
        const res = await fetch(gateway, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) ipfsMetadata = await res.json() as object;
      } catch { /* continue without */ }
    }

    return {
      ipId,
      ...(local ? {
        title: local.title,
        type: local.type,
        license: local.license,
        revenueShare: local.revenueShare,
        contentHash: local.contentHash,
        registeredAt: local.registeredAt,
        explorerUrl: local.explorerUrl,
        parentIpId: local.parentIpId,
        nearAccount: local.nearAccount,
        chainSequence: local.chainSequence,
        chainHash: local.chainHash,
      } : { note: 'Not found in local registrations. Metadata from IPFS only.' }),
      ipfsMetadata,
    };
  },
};
