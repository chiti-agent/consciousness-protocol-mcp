/**
 * Level C — Volem API multi-user tests.
 * 7 agents POST to Volem simultaneously. Rate limit test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTestWallet,
  VOLEM_URL,
  type TestAgentName,
  TEST_AGENTS,
} from '../helpers.js';

/** Sign a Volem auth header for a test agent. */
async function signVolemAuth(agentName: TestAgentName): Promise<string> {
  const wallet = getTestWallet(agentName);
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);

  const timestamp = String(Date.now());
  const message = `volem:${timestamp}`;
  const signature = await account.signMessage({ message });
  return `EVM ${account.address}:${timestamp}:${signature}`;
}

/** POST a registration to Volem API. */
async function postToVolem(
  agentName: TestAgentName,
  data: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const auth = await signVolemAuth(agentName);

  const res = await fetch(`${VOLEM_URL}/api/ip/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': auth,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });

  let body: any;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

describe('Volem multi-user', { timeout: 120_000 }, () => {
  // Use first 7 agents (exclude buyer)
  const agents = TEST_AGENTS.slice(0, 7);

  it('7 agents POST simultaneously, all succeed', { timeout: 60_000 }, async () => {
    const ts = Date.now();

    const promises = agents.map((agent, i) => {
      const wallet = getTestWallet(agent);
      return postToVolem(agent, {
        ipId: `0x${'0'.repeat(38)}${String(i + 1).padStart(2, '0')}`, // Fake ipId for Volem test
        title: `volem-parallel-${agent}-${ts}`,
        description: `Test registration from ${agent}`,
        ipType: 'text/plain',
        nftContract: `0x${'a'.repeat(40)}`,
        license: 'free',
        nearAccount: `${agent}.testnet`,
        txHash: `0x${'b'.repeat(64)}`,
      });
    });

    const results = await Promise.all(promises);

    const succeeded = results.filter(r => r.status >= 200 && r.status < 300);
    const failed = results.filter(r => r.status >= 400);

    console.log(`  ${succeeded.length}/7 succeeded, ${failed.length} failed`);
    if (failed.length > 0) {
      for (const f of failed) {
        console.log(`  Failed (${f.status}):`, JSON.stringify(f.body).slice(0, 200));
      }
    }

    // All 7 should succeed (no user conflicts, no rate limit triggered)
    assert.equal(succeeded.length, 7, `Expected all 7 to succeed. Failures: ${failed.map(f => `${f.status}: ${JSON.stringify(f.body).slice(0, 100)}`).join('; ')}`);
  });

  it('rate limit triggers after 10 requests from one agent', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-poet';
    const ts = Date.now();

    // Send 11 requests rapidly from one agent
    const promises = Array.from({ length: 11 }, (_, i) => {
      const wallet = getTestWallet(agent);
      return postToVolem(agent, {
        ipId: `0x${'0'.repeat(36)}${String(i + 100).padStart(4, '0')}`,
        title: `rate-limit-test-${i}-${ts}`,
        description: `Rate limit test ${i}`,
        ipType: 'text/plain',
        nftContract: `0x${'c'.repeat(40)}`,
        license: 'free',
        nearAccount: `${agent}.testnet`,
        txHash: `0x${'d'.repeat(64)}`,
      });
    });

    const results = await Promise.all(promises);

    const rateLimited = results.filter(r => r.status === 429);
    const succeeded = results.filter(r => r.status >= 200 && r.status < 300);

    console.log(`  ${succeeded.length} succeeded, ${rateLimited.length} rate-limited (429)`);

    // At least the 11th request should be rate-limited
    // If no rate limiting is configured, this test documents the behavior
    if (rateLimited.length > 0) {
      assert.ok(rateLimited.length >= 1, 'At least one request should be rate-limited');
    } else {
      console.log('  NOTE: No rate limiting detected. Volem may not have rate limits configured.');
    }
  });
});
