/**
 * Level B integration tests for search tool.
 * Tests listOwn (local registrations.json), getAssetDetails, and Volem search with fallback.
 *
 * Strategy: redirect HOME to temp dir, write fixture registrations.json, test locally.
 * Volem search tested conditionally (skipped if localhost:3005 not available).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect HOME before importing search module
const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'search-test-'));
process.env.HOME = TEMP_HOME;

const { searchTool } = await import('../../src/tools/search.js');
import type { Config } from '../../src/config/store.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const CONFIG_DIR = join(TEMP_HOME, '.consciousness-protocol');
const REGISTRATIONS_FILE = join(CONFIG_DIR, 'registrations.json');

// Fixture data: 3 registrations with different types and licenses
const FIXTURE_REGISTRATIONS = [
  {
    ipId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    tokenId: '1',
    title: 'Test Poem',
    type: 'poem',
    license: 'free',
    revenueShare: 0,
    contentHash: 'abc123',
    ipfsUri: 'ipfs://QmTestPoem',
    explorerUrl: 'https://aeneid.explorer.story.foundation/ipa/0xAAAA',
    registeredAt: '2026-03-23T10:00:00.000Z',
  },
  {
    ipId: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    tokenId: '2',
    title: 'Test Code',
    type: 'code',
    license: 'commercial-remix',
    revenueShare: 5,
    contentHash: 'def456',
    ipfsUri: 'ipfs://QmTestCode',
    explorerUrl: 'https://aeneid.explorer.story.foundation/ipa/0xBBBB',
    registeredAt: '2026-03-23T11:00:00.000Z',
  },
  {
    ipId: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    tokenId: '3',
    title: 'Test Hypothesis',
    type: 'analysis',
    license: 'free',
    revenueShare: 0,
    contentHash: 'ghi789',
    ipfsUri: 'ipfs://QmTestHypothesis',
    explorerUrl: 'https://aeneid.explorer.story.foundation/ipa/0xCCCC',
    registeredAt: '2026-03-23T12:00:00.000Z',
  },
];

function makeLocalConfig(): Config {
  return {
    network: 'testnet',
    near: { accountId: 'test.testnet', registryContract: 'consciousness-protocol.testnet' },
    story: { evmAddress: '0x0000000000000000000000000000000000000001', chainId: 'aeneid', rpcUrl: 'https://aeneid.storyrpc.io' },
    ipfs: {},
    backend: 'local',
  };
}

function makeVolemConfig(): Config {
  return {
    ...makeLocalConfig(),
    backend: 'volem',
    volemApiUrl: 'http://localhost:3005',
  };
}

async function isVolemAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3005/api/ip/search', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('Level B: Search Tool Integration', () => {
  before(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(REGISTRATIONS_FILE, JSON.stringify(FIXTURE_REGISTRATIONS, null, 2));
  });

  after(() => {
    process.env.HOME = ORIGINAL_HOME;
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  describe('listOwn (local)', () => {
    it('returns all registrations with no filter', () => {
      const result = searchTool.listOwn();

      assert.equal(result.total, 3);
      assert.equal(result.source, 'local');
      assert.equal(result.works.length, 3);
    });

    it('filters by type', () => {
      const result = searchTool.listOwn({ type: 'poem' });

      assert.equal(result.total, 1);
      assert.equal(result.works[0].title, 'Test Poem');
      assert.equal(result.works[0].type, 'poem');
    });

    it('filters by license', () => {
      const result = searchTool.listOwn({ license: 'free' });

      assert.equal(result.total, 2);
      assert.ok(result.works.every(w => w.license === 'free'));
    });

    it('filters by type AND license combined', () => {
      const result = searchTool.listOwn({ type: 'poem', license: 'free' });

      assert.equal(result.total, 1);
      assert.equal(result.works[0].title, 'Test Poem');
    });

    it('returns empty when filter matches nothing', () => {
      const result = searchTool.listOwn({ type: 'nonexistent' });

      assert.equal(result.total, 0);
      assert.equal(result.works.length, 0);
    });
  });

  describe('search (backend dispatch)', () => {
    it('no query params returns local listOwn', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.search(config, {});

      assert.equal(result.source, 'local');
      assert.equal(result.total, 3);
    });

    it('no query with type filter returns filtered local', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.search(config, { type: 'code' });

      assert.equal(result.source, 'local');
      assert.equal(result.total, 1);
      assert.equal(result.works[0].type, 'code');
    });

    it('local backend ignores query and returns listOwn', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.search(config, { query: 'poem' });

      // With backend=local and a query, it still uses listOwn
      assert.equal(result.source, 'local');
    });
  });

  describe('getAssetDetails', () => {
    it('returns local details for known ipId', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.getAssetDetails(config, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') as any;

      assert.equal(result.source, 'local');
      assert.equal(result.title, 'Test Poem');
      assert.equal(result.type, 'poem');
      assert.equal(result.license, 'free');
      assert.equal(result.contentHash, 'abc123');
    });

    it('returns local details case-insensitively', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.getAssetDetails(config, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') as any;

      assert.equal(result.title, 'Test Poem', 'should match case-insensitively');
    });

    it('returns "not found" note for unknown ipId', async () => {
      const config = makeLocalConfig();
      const result = await searchTool.getAssetDetails(config, '0x0000000000000000000000000000000000000000') as any;

      assert.equal(result.source, 'local');
      assert.ok(result.note, 'should include not-found note');
      assert.ok(result.note.includes('Not found'));
    });
  });

  describe('Volem search (conditional)', () => {
    it('falls back to local when Volem is not available', async () => {
      // Use a Volem URL that won't respond
      const config: Config = {
        ...makeLocalConfig(),
        backend: 'volem',
        volemApiUrl: 'http://localhost:59999', // unlikely to be running
      };

      const result = await searchTool.search(config, { query: 'poem' });

      // Should fall back to local
      assert.equal(result.source, 'local');
    });

    it('queries Volem when available', async () => {
      const available = await isVolemAvailable();
      if (!available) {
        // Skip gracefully — not an error
        return;
      }

      const config = makeVolemConfig();
      const result = await searchTool.search(config, { query: 'test' });

      assert.equal(result.source, 'volem');
      assert.ok(Array.isArray(result.works));
    });
  });
});
