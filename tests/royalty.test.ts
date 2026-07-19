/**
 * Unit tests for royalty tool pure helpers — findDirectChildren, findAllDescendants,
 * resolveVolemApiUrl, computeChildRevShare, computeFinancialSummary.
 *
 * All tests are offline and deterministic — no network calls, no file system, no viem.
 * Uses Node.js built-in test runner (no external deps).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDirectChildren,
  findAllDescendants,
  resolveVolemApiUrl,
  computeChildRevShare,
  computePolicyPending,
  computeFinancialSummary,
} from '../src/tools/royalty.js';
import type { Config } from '../src/config/store.js';

// ---------------------------------------------------------------------------
// Minimal Config factory — only the fields used by resolveVolemApiUrl
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    network: 'testnet',
    near: { accountId: 'test.near', registryContract: 'registry.near' },
    story: {
      evmAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'aeneid',
      rpcUrl: 'http://localhost:8545',
    },
    ipfs: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. findDirectChildren
// ---------------------------------------------------------------------------

describe('findDirectChildren', () => {
  const parent = '0xParent';
  const child1 = '0xChild1';
  const child2 = '0xChild2';
  const other = '0xOther';

  it('returns only entries matching parentIpId with success=true and ipId present', () => {
    const registrations = [
      { success: true, ipId: child1, parentIpId: parent },
      { success: true, ipId: child2, parentIpId: parent },
      { success: true, ipId: '0xUnrelated', parentIpId: other },
    ];
    const result = findDirectChildren(registrations, parent);
    assert.equal(result.length, 2);
    assert.equal(result[0].ipId, child1);
    assert.equal(result[1].ipId, child2);
  });

  it('excludes failed registrations (success=false)', () => {
    const registrations = [
      { success: true, ipId: child1, parentIpId: parent },
      { success: false, ipId: child2, parentIpId: parent },
    ];
    const result = findDirectChildren(registrations, parent);
    assert.equal(result.length, 1);
    assert.equal(result[0].ipId, child1);
  });

  it('excludes registrations where success is absent (undefined)', () => {
    const registrations = [
      { success: true, ipId: child1, parentIpId: parent },
      { ipId: child2, parentIpId: parent }, // success missing
    ];
    const result = findDirectChildren(registrations, parent);
    assert.equal(result.length, 1);
    assert.equal(result[0].ipId, child1);
  });

  it('excludes registrations with non-matching parentIpId', () => {
    const registrations = [
      { success: true, ipId: child1, parentIpId: other },
    ];
    const result = findDirectChildren(registrations, parent);
    assert.deepEqual(result, []);
  });

  it('excludes entries missing ipId', () => {
    const registrations = [
      { success: true, parentIpId: parent }, // ipId missing
      { success: true, ipId: '', parentIpId: parent }, // empty string is falsy
    ];
    const result = findDirectChildren(registrations, parent);
    assert.deepEqual(result, []);
  });

  it('returns [] when no children exist for the parent', () => {
    const registrations = [
      { success: true, ipId: child1, parentIpId: other },
    ];
    const result = findDirectChildren(registrations, parent);
    assert.deepEqual(result, []);
  });

  it('returns [] for empty registrations array', () => {
    assert.deepEqual(findDirectChildren([], parent), []);
  });
});

// ---------------------------------------------------------------------------
// 2. findAllDescendants
// ---------------------------------------------------------------------------

describe('findAllDescendants', () => {
  // Note: these tests assume an acyclic forest (real-world constraint).
  // The current implementation would infinite-recurse on cyclic graphs,
  // which cannot occur in Story Protocol's derivative IP structure.

  it('returns only direct children when grandchildren are absent', () => {
    const registrations = [
      { success: true, ipId: '0xChild1', parentIpId: '0xParent' },
      { success: true, ipId: '0xChild2', parentIpId: '0xParent' },
    ];
    const result = findAllDescendants(registrations, '0xParent');
    assert.equal(result.length, 2);
    assert.equal(result[0].ipId, '0xChild1');
    assert.equal(result[1].ipId, '0xChild2');
  });

  it('returns all descendants in a 4-level linear chain (depth-first)', () => {
    // parent → child → grandchild → great-grandchild
    const registrations = [
      { success: true, ipId: '0xChild', parentIpId: '0xParent' },
      { success: true, ipId: '0xGrand', parentIpId: '0xChild' },
      { success: true, ipId: '0xGreat', parentIpId: '0xGrand' },
    ];
    const result = findAllDescendants(registrations, '0xParent');
    assert.equal(result.length, 3);
    // Depth-first: child appears before its own descendants
    assert.equal(result[0].ipId, '0xChild');
    assert.equal(result[1].ipId, '0xGrand');
    assert.equal(result[2].ipId, '0xGreat');
  });

  it('direct child appears before its own descendants (depth-first ordering)', () => {
    const registrations = [
      { success: true, ipId: '0xA', parentIpId: '0xRoot' },
      { success: true, ipId: '0xA1', parentIpId: '0xA' },
    ];
    const result = findAllDescendants(registrations, '0xRoot');
    const ids = result.map((r) => r.ipId);
    // 0xA must appear before 0xA1
    assert.ok(ids.indexOf('0xA') < ids.indexOf('0xA1'), 'parent must precede its own descendant');
  });

  it('includes both sibling subtrees', () => {
    // root → A (→ A1), root → B (→ B1)
    const registrations = [
      { success: true, ipId: '0xA', parentIpId: '0xRoot' },
      { success: true, ipId: '0xA1', parentIpId: '0xA' },
      { success: true, ipId: '0xB', parentIpId: '0xRoot' },
      { success: true, ipId: '0xB1', parentIpId: '0xB' },
    ];
    const result = findAllDescendants(registrations, '0xRoot');
    const ids = result.map((r) => r.ipId);
    assert.equal(ids.length, 4);
    assert.ok(ids.includes('0xA'));
    assert.ok(ids.includes('0xA1'));
    assert.ok(ids.includes('0xB'));
    assert.ok(ids.includes('0xB1'));
  });

  it('returns [] for a leaf node with no children', () => {
    const registrations = [
      { success: true, ipId: '0xChild', parentIpId: '0xParent' },
    ];
    // 0xChild has no children of its own
    const result = findAllDescendants(registrations, '0xChild');
    assert.deepEqual(result, []);
  });

  it('returns [] for an unknown parentIpId', () => {
    const registrations = [
      { success: true, ipId: '0xChild', parentIpId: '0xParent' },
    ];
    assert.deepEqual(findAllDescendants(registrations, '0xNobody'), []);
  });

  it('returns [] for empty registrations array', () => {
    assert.deepEqual(findAllDescendants([], '0xParent'), []);
  });
});

// ---------------------------------------------------------------------------
// 3. resolveVolemApiUrl
// ---------------------------------------------------------------------------

describe('resolveVolemApiUrl', () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.VOLEM_API_URL;
    delete process.env.VOLEM_API_URL;
  });

  after(() => {
    if (savedEnv === undefined) {
      delete process.env.VOLEM_API_URL;
    } else {
      process.env.VOLEM_API_URL = savedEnv;
    }
  });

  it('returns config.volemApiUrl when it is set', () => {
    const config = makeConfig({ volemApiUrl: 'http://custom-volem:4000' });
    const result = resolveVolemApiUrl(config);
    assert.equal(result, 'http://custom-volem:4000');
  });

  it('falls back to process.env.VOLEM_API_URL when config field is absent', () => {
    process.env.VOLEM_API_URL = 'http://env-volem:5000';
    const config = makeConfig(); // volemApiUrl not set
    const result = resolveVolemApiUrl(config);
    assert.equal(result, 'http://env-volem:5000');
    delete process.env.VOLEM_API_URL;
  });

  it('falls back to http://localhost:3010 when neither config nor env is set', () => {
    delete process.env.VOLEM_API_URL;
    const config = makeConfig(); // volemApiUrl not set
    const result = resolveVolemApiUrl(config);
    assert.equal(result, 'http://localhost:3010');
  });

  it('config.volemApiUrl takes precedence over process.env.VOLEM_API_URL', () => {
    process.env.VOLEM_API_URL = 'http://env-volem:5000';
    const config = makeConfig({ volemApiUrl: 'http://config-volem:4000' });
    const result = resolveVolemApiUrl(config);
    assert.equal(result, 'http://config-volem:4000');
    delete process.env.VOLEM_API_URL;
  });
});

// ---------------------------------------------------------------------------
// 4. computeChildRevShare
// ---------------------------------------------------------------------------

describe('computeChildRevShare', () => {
  it('10% of round revenue with zero transferred: expected=10%, pending=expected', () => {
    const childRevenue = 1000n;
    const transferred = 0n;
    const { expected, pending } = computeChildRevShare(childRevenue, transferred, 10);
    assert.equal(expected, 100n); // 1000 * 1000 / 10000 = 100
    assert.equal(pending, 100n);
  });

  it('when transferred >= expected, pending is 0 (never negative)', () => {
    const childRevenue = 1000n;
    const transferred = 200n; // more than the 10% expected (100)
    const { expected, pending } = computeChildRevShare(childRevenue, transferred, 10);
    assert.equal(expected, 100n);
    assert.equal(pending, 0n);
  });

  it('when transferred equals expected exactly, pending is 0', () => {
    const childRevenue = 1000n;
    const transferred = 100n; // exactly 10%
    const { expected, pending } = computeChildRevShare(childRevenue, transferred, 10);
    assert.equal(expected, 100n);
    assert.equal(pending, 0n);
  });

  it('fractional pct (2.5%) uses Math.round(pct*100) bps correctly', () => {
    // 2.5% → revShareBps = Math.round(2.5 * 100) = 250
    // 4000 * 250 / 10000 = 100
    const childRevenue = 4000n;
    const transferred = 0n;
    const { expected, pending } = computeChildRevShare(childRevenue, transferred, 2.5);
    assert.equal(expected, 100n);
    assert.equal(pending, 100n);
  });

  it('0% revenue share: expected=0, pending=0', () => {
    const { expected, pending } = computeChildRevShare(5000n, 0n, 0);
    assert.equal(expected, 0n);
    assert.equal(pending, 0n);
  });

  it('0 childRevenue: expected=0, pending=0 regardless of pct', () => {
    const { expected, pending } = computeChildRevShare(0n, 0n, 10);
    assert.equal(expected, 0n);
    assert.equal(pending, 0n);
  });

  it('works on large wei-scale bigints (1 ETH in wei)', () => {
    const oneEthWei = 1_000_000_000_000_000_000n; // 1e18
    const transferred = 0n;
    const { expected, pending } = computeChildRevShare(oneEthWei, transferred, 10);
    // 10% of 1e18 = 1e17
    assert.equal(expected, 100_000_000_000_000_000n);
    assert.equal(pending, 100_000_000_000_000_000n);
  });

  it('partial pending: only uncovered portion is returned', () => {
    // 1000 revenue, 10% = 100 expected, 60 already transferred → 40 pending
    const { expected, pending } = computeChildRevShare(1000n, 60n, 10);
    assert.equal(expected, 100n);
    assert.equal(pending, 40n);
  });
});

// ---------------------------------------------------------------------------
// 4b. computePolicyPending — exact transferToVault mirror (10^8 = 100%)
// ---------------------------------------------------------------------------

describe('computePolicyPending', () => {
  const WEI = (n: number) => BigInt(Math.round(n * 1e18));

  it('LAP flat share: 10% of any-depth descendant, no stack deduction', () => {
    // act3 numbers: 0.1 payment on L6, ROOT expects 0.01 at any depth
    const { expected, pending } = computePolicyPending(WEI(0.1), 10_000_000, 0, 0n);
    assert.equal(expected, WEI(0.01));
    assert.equal(pending, WEI(0.01));
  });

  it('LRP direct parent: 10% minus own ancestor stack (act7 L1 case)', () => {
    // 0.09 on L2; L1 policyPct=10%, L1 stack=10% (its parent ROOT)
    // max = 0.009, minus 10% = 0.0081
    const { expected } = computePolicyPending(WEI(0.09), 10_000_000, 10_000_000, 0n);
    assert.equal(expected, WEI(0.0081));
  });

  it('LRP grandparent: decayed 1%, empty stack (act7 ROOT case)', () => {
    const { expected } = computePolicyPending(WEI(0.09), 1_000_000, 0, 0n);
    assert.equal(expected, WEI(0.0009));
  });

  it('fully transferred → pending 0 (post-claim state)', () => {
    const { pending } = computePolicyPending(WEI(0.09), 1_000_000, 0, WEI(0.0009));
    assert.equal(pending, 0n);
  });

  it('over-transferred clamps to 0, never negative', () => {
    const { pending } = computePolicyPending(1000n, 10_000_000, 0, 500n);
    assert.equal(pending, 0n);
  });

  it('unrelated node: policyPct 0 → expected 0', () => {
    const { expected, pending } = computePolicyPending(WEI(1), 0, 0, 0n);
    assert.equal(expected, 0n);
    assert.equal(pending, 0n);
  });
});

// ---------------------------------------------------------------------------
// 5. computeFinancialSummary
// ---------------------------------------------------------------------------

describe('computeFinancialSummary', () => {
  it('mintingFeeEarned = totalReceived - revenueShareTransferred when positive', () => {
    const { mintingFeeEarned } = computeFinancialSummary({
      totalReceived: 1000n,
      claimable: 0n,
      revenueShareTransferred: 300n,
      revenueSharePending: 0n,
    });
    assert.equal(mintingFeeEarned, 700n);
  });

  it('guard: when revenueShareTransferred > totalReceived, mintingFeeEarned falls back to totalReceived', () => {
    const { mintingFeeEarned } = computeFinancialSummary({
      totalReceived: 200n,
      claimable: 0n,
      revenueShareTransferred: 500n, // more than totalReceived
      revenueSharePending: 0n,
    });
    // Should return totalReceived, not go negative
    assert.equal(mintingFeeEarned, 200n);
  });

  it('guard: when revenueShareTransferred equals totalReceived, mintingFeeEarned is totalReceived (not zero)', () => {
    // The condition is strictly >, so equal falls to the else branch → totalReceived
    const { mintingFeeEarned } = computeFinancialSummary({
      totalReceived: 300n,
      claimable: 0n,
      revenueShareTransferred: 300n,
      revenueSharePending: 0n,
    });
    assert.equal(mintingFeeEarned, 300n);
  });

  it('claimableNow = claimable + revenueSharePending', () => {
    const { claimableNow } = computeFinancialSummary({
      totalReceived: 1000n,
      claimable: 150n,
      revenueShareTransferred: 0n,
      revenueSharePending: 75n,
    });
    assert.equal(claimableNow, 225n);
  });

  it('totalEarned = mintingFeeEarned + revenueShareTransferred + revenueSharePending', () => {
    const { totalEarned } = computeFinancialSummary({
      totalReceived: 1000n,
      claimable: 0n,
      revenueShareTransferred: 300n,
      revenueSharePending: 50n,
    });
    // mintingFeeEarned = 1000 - 300 = 700; totalEarned = 700 + 300 + 50 = 1050
    assert.equal(totalEarned, 1050n);
  });

  it('realistic combined scenario with all four inputs non-zero', () => {
    // totalReceived=5000, revenueShareTransferred=1200, revenueSharePending=300, claimable=400
    const summary = computeFinancialSummary({
      totalReceived: 5000n,
      claimable: 400n,
      revenueShareTransferred: 1200n,
      revenueSharePending: 300n,
    });
    // mintingFeeEarned = 5000 - 1200 = 3800
    assert.equal(summary.mintingFeeEarned, 3800n);
    // claimableNow = 400 + 300 = 700
    assert.equal(summary.claimableNow, 700n);
    // totalEarned = 3800 + 1200 + 300 = 5300
    assert.equal(summary.totalEarned, 5300n);
  });

  it('all zeros returns all zeros', () => {
    const summary = computeFinancialSummary({
      totalReceived: 0n,
      claimable: 0n,
      revenueShareTransferred: 0n,
      revenueSharePending: 0n,
    });
    assert.equal(summary.mintingFeeEarned, 0n);
    assert.equal(summary.claimableNow, 0n);
    assert.equal(summary.totalEarned, 0n);
  });
});
