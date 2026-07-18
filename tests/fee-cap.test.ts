/**
 * Unit tests for the fee-cap transport guard.
 * Reproduces the 2026-07-03 incident: node suggests a 500 gwei priority fee
 * while base fee is ~0 — the transport must clamp the suggestion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cappedHttp, MAX_PRIORITY_FEE_WEI, MAX_GAS_PRICE_WEI } from '../src/config/fee-cap.js';
import type { http as viemHttp } from 'viem';

const GWEI = 1_000_000_000n;

/** Fake viem http factory whose transport answers from a canned response map. */
function fakeHttp(responses: Record<string, unknown>): typeof viemHttp {
  return ((_url?: string) => (_opts: unknown) => ({
    config: { key: 'http', name: 'HTTP JSON-RPC', type: 'http' },
    async request(args: { method: string }) {
      if (args.method in responses) return responses[args.method];
      throw new Error(`unexpected method ${args.method}`);
    },
    value: undefined,
  })) as unknown as typeof viemHttp;
}

function makeTransport(responses: Record<string, unknown>) {
  return cappedHttp(fakeHttp(responses), 'http://fake')({} as never) as unknown as {
    request(args: { method: string }): Promise<unknown>;
  };
}

describe('cappedHttp', () => {
  it('clamps poisoned eth_maxPriorityFeePerGas (500 gwei -> cap)', async () => {
    const poisoned = `0x${(500n * GWEI).toString(16)}`;
    const t = makeTransport({ eth_maxPriorityFeePerGas: poisoned });
    const res = await t.request({ method: 'eth_maxPriorityFeePerGas' });
    assert.equal(BigInt(res as string), MAX_PRIORITY_FEE_WEI);
  });

  it('clamps poisoned eth_gasPrice to its own cap', async () => {
    const poisoned = `0x${(500n * GWEI).toString(16)}`;
    const t = makeTransport({ eth_gasPrice: poisoned });
    const res = await t.request({ method: 'eth_gasPrice' });
    assert.equal(BigInt(res as string), MAX_GAS_PRICE_WEI);
  });

  it('passes benign fee suggestions through unchanged', async () => {
    const benign = `0x${(GWEI / 1000n).toString(16)}`; // 0.001 gwei — today's Aeneid
    const t = makeTransport({ eth_maxPriorityFeePerGas: benign });
    const res = await t.request({ method: 'eth_maxPriorityFeePerGas' });
    assert.equal(res, benign);
  });

  it('passes the exact cap value through unchanged (boundary)', async () => {
    const atCap = `0x${MAX_PRIORITY_FEE_WEI.toString(16)}`;
    const t = makeTransport({ eth_maxPriorityFeePerGas: atCap });
    const res = await t.request({ method: 'eth_maxPriorityFeePerGas' });
    assert.equal(res, atCap);
  });

  it('does not touch unrelated methods even with huge hex results', async () => {
    const huge = `0x${(10_000n * GWEI).toString(16)}`;
    const t = makeTransport({ eth_getBalance: huge });
    const res = await t.request({ method: 'eth_getBalance' });
    assert.equal(res, huge);
  });

  it('does not touch non-string results', async () => {
    const block = { number: '0x1', baseFeePerGas: `0x${(500n * GWEI).toString(16)}` };
    const t = makeTransport({ eth_getBlockByNumber: block });
    const res = await t.request({ method: 'eth_getBlockByNumber' });
    assert.deepEqual(res, block);
  });
});
