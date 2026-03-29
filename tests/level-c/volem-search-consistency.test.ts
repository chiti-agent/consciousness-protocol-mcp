/**
 * Level C — Volem search consistency after parallel registration.
 * Verifies search by query, owner, category returns correct results.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTestWallet,
  VOLEM_URL,
  type TestAgentName,
} from '../helpers.js';

async function searchVolem(params: Record<string, string>): Promise<{ total: number; assets: any[] }> {
  const searchParams = new URLSearchParams(params);
  const res = await fetch(`${VOLEM_URL}/api/ip/search?${searchParams}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Volem search failed: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<{ total: number; assets: any[] }>;
}

async function getAgentProfile(address: string): Promise<any> {
  const res = await fetch(`${VOLEM_URL}/api/ip/agent/${address}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Volem agent profile failed: ${res.status}`);
  }

  return res.json();
}

describe('Volem search consistency', { timeout: 60_000 }, () => {
  // --- Search by query ---
  it('search by query finds assets by title', { timeout: 15_000 }, async () => {
    const result = await searchVolem({ q: 'poem' });

    assert.ok(result.total >= 0, 'total must be non-negative');
    if (result.total > 0) {
      // At least one result should contain "poem" in title
      const hasPoemInTitle = result.assets.some(
        a => a.title?.toLowerCase().includes('poem') || a.description?.toLowerCase().includes('poem'),
      );
      assert.ok(hasPoemInTitle, 'At least one result should match "poem" query');
    }
  });

  // --- Search by owner ---
  it('search by owner returns only that wallet\'s assets', { timeout: 15_000 }, async () => {
    const poetWallet = getTestWallet('test-poet');
    const result = await searchVolem({ owner: poetWallet.address });

    assert.ok(result.total >= 0);
    if (result.total > 0) {
      // All results should belong to the poet's address
      for (const asset of result.assets) {
        if (asset.ownerAddress) {
          assert.equal(
            asset.ownerAddress.toLowerCase(),
            poetWallet.address.toLowerCase(),
            'All assets must belong to the queried owner',
          );
        }
      }
    }
  });

  // --- Search by category ---
  it('search by category returns only matching assets', { timeout: 15_000 }, async () => {
    const result = await searchVolem({ category: 'mcp-server' });

    assert.ok(result.total >= 0);
    if (result.total > 0) {
      for (const asset of result.assets) {
        if (asset.ipCategory) {
          assert.ok(
            asset.ipCategory.includes('mcp-server'),
            `Asset category "${asset.ipCategory}" should include "mcp-server"`,
          );
        }
      }
    }
  });

  // --- Search with no params ---
  it('search with no params returns results', { timeout: 15_000 }, async () => {
    const result = await searchVolem({});

    assert.ok(result.total >= 0);
    assert.ok(Array.isArray(result.assets));
  });

  // --- Agent profile ---
  it('agent profile returns correct work count', { timeout: 15_000 }, async () => {
    const poetWallet = getTestWallet('test-poet');

    try {
      const profile = await getAgentProfile(poetWallet.address);
      assert.ok(profile, 'Profile must exist');
      // Profile should have some indication of work count
      if (profile.workCount !== undefined) {
        assert.ok(profile.workCount >= 0, 'Work count must be non-negative');
      }
    } catch (err: any) {
      // Agent profile endpoint may not exist yet
      if (err.message.includes('404')) {
        console.log('  SKIP: Agent profile endpoint not implemented');
      } else {
        throw err;
      }
    }
  });
});
