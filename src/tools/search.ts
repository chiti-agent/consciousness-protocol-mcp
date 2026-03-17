/**
 * Search and list registered IP assets.
 *
 * Three backends:
 * 1. volem (default) — Volem API for own assets + ecosystem search
 * 2. story — Story Protocol API v4 for ecosystem-wide search
 * 3. local — registrations.json only (offline, no external calls)
 *
 * Local registrations.json is always checked first as primary source for own works.
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
  source: 'local' | 'volem' | 'story';
  works: Array<{
    ipId: string;
    title: string;
    type: string;
    license: string;
    revenueShare: number;
    registeredAt: string;
    explorerUrl: string;
    parentIpId?: string;
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

function listOwn(filter?: { type?: string; license?: string }): SearchResult {
  let regs = loadRegistrations();
  if (filter?.type) regs = regs.filter(r => r.type === filter.type);
  if (filter?.license) regs = regs.filter(r => r.license === filter.license);

  return {
    total: regs.length,
    source: 'local',
    works: regs.map(r => ({
      ipId: r.ipId,
      title: r.title,
      type: r.type,
      license: r.license,
      revenueShare: r.revenueShare,
      registeredAt: r.registeredAt,
      explorerUrl: r.explorerUrl,
      parentIpId: r.parentIpId,
    })),
  };
}

async function searchVolem(
  config: Config,
  params: { query?: string; creator?: string; type?: string; limit?: number },
): Promise<SearchResult> {
  const baseUrl = config.volemApiUrl ?? 'http://localhost:3005';
  const searchParams = new URLSearchParams();
  if (params.query) searchParams.set('q', params.query);
  if (params.creator) searchParams.set('owner', params.creator);
  if (params.type) searchParams.set('type', params.type);
  if (params.limit) searchParams.set('limit', String(params.limit));

  try {
    const res = await fetch(`${baseUrl}/api/ip/search?${searchParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return listOwn({ type: params.type }); // fallback to local

    const data = await res.json() as { total: number; assets: Array<{
      ipId: string; title: string; ipType?: string; license?: string;
      revenueShare?: number; registeredAt: string; ownerAddress?: string;
      parentIpId?: string;
    }> };

    return {
      total: data.total,
      source: 'volem',
      works: data.assets.map(a => ({
        ipId: a.ipId,
        title: a.title,
        type: a.ipType ?? 'unknown',
        license: a.license ?? 'unknown',
        revenueShare: a.revenueShare ?? 0,
        registeredAt: a.registeredAt,
        explorerUrl: `${baseUrl}/marketplace/asset/${a.ipId}`,
        parentIpId: a.parentIpId,
      })),
    };
  } catch {
    return listOwn({ type: params.type }); // fallback to local
  }
}

async function searchStory(
  config: Config,
  params: { query?: string; creator?: string; type?: string; limit?: number },
): Promise<SearchResult> {
  const apiKey = config.storyApiKey;
  if (!apiKey) {
    return { total: 0, source: 'story', works: [] };
  }

  const baseUrl = 'https://api.storyapis.com';

  try {
    // Use semantic search if query provided
    if (params.query) {
      const res = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          query: params.query,
          pagination: { limit: params.limit ?? 20, offset: 0 },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { total: 0, source: 'story', works: [] };

      const data = await res.json() as { data?: Array<{
        id: string; title?: string; description?: string;
        mediaType?: string; owner?: string;
      }> };

      return {
        total: (data.data ?? []).length,
        source: 'story',
        works: (data.data ?? []).map(a => ({
          ipId: a.id,
          title: a.title ?? `IP ${a.id.slice(0, 10)}`,
          type: a.mediaType ?? 'unknown',
          license: 'unknown',
          revenueShare: 0,
          registeredAt: '',
          explorerUrl: `https://explorer.story.foundation/ipa/${a.id}`,
        })),
      };
    }

    // Use assets list with owner filter
    const body: Record<string, unknown> = {
      orderBy: 'createdAt',
      orderDirection: 'desc',
      pagination: { limit: params.limit ?? 20, offset: 0 },
    };
    if (params.creator) {
      body.where = { ownerAddress: params.creator };
    }

    const res = await fetch(`${baseUrl}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { total: 0, source: 'story', works: [] };

    const data = await res.json() as { data?: Array<{
      id: string; owner?: string;
    }> };

    return {
      total: (data.data ?? []).length,
      source: 'story',
      works: (data.data ?? []).map(a => ({
        ipId: a.id,
        title: `IP ${a.id.slice(0, 10)}`,
        type: 'unknown',
        license: 'unknown',
        revenueShare: 0,
        registeredAt: '',
        explorerUrl: `https://explorer.story.foundation/ipa/${a.id}`,
      })),
    };
  } catch {
    return { total: 0, source: 'story', works: [] };
  }
}

export const searchTool = {
  listOwn,

  async search(
    config: Config,
    params: { query?: string; creator?: string; type?: string; license?: string; limit?: number },
  ): Promise<SearchResult> {
    const backend = config.backend ?? 'volem';

    // No query params = list own works (always local)
    if (!params.query && !params.creator) {
      return listOwn({ type: params.type, license: params.license });
    }

    switch (backend) {
      case 'volem':
        return searchVolem(config, params);
      case 'story':
        return searchStory(config, params);
      case 'local':
      default:
        return listOwn({ type: params.type, license: params.license });
    }
  },

  async getAssetDetails(
    config: Config,
    ipId: string,
  ): Promise<object> {
    const backend = config.backend ?? 'volem';

    // Always check local first
    const regs = loadRegistrations();
    const local = regs.find(r => r.ipId?.toLowerCase() === ipId.toLowerCase());

    // Try Volem API for full details
    if (backend === 'volem') {
      const baseUrl = config.volemApiUrl ?? 'http://localhost:3005';
      try {
        const res = await fetch(`${baseUrl}/api/ip/${ipId}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json();
          return { source: 'volem', ...data };
        }
      } catch { /* fallback below */ }
    }

    // Fallback: local + IPFS
    let ipfsMetadata: object | null = null;
    if (local?.ipfsUri) {
      const gateway = local.ipfsUri.replace('ipfs://', config.ipfs.gateway ?? 'https://gateway.pinata.cloud/ipfs/');
      try {
        const res = await fetch(gateway, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) ipfsMetadata = await res.json() as object;
      } catch { /* continue without */ }
    }

    return {
      source: 'local',
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
      } : { note: 'Not found in local registrations.' }),
      ipfsMetadata,
    };
  },
};
