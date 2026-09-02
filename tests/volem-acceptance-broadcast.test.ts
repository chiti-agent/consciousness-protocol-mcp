import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'volem-acceptance-test-'));
process.env.HOME = testHome;

const { saveKey } = await import('../src/config/store.js');
const { prepareBroadcastAndRecord } = await import('../src/volem/acceptance-broadcast.js');
const { VolemRequestJournal } = await import('../src/volem/request-journal.js');

saveKey('evm', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const config = {
  network: 'testnet' as const,
  near: { accountId: 'agent.testnet', registryContract: 'registry.testnet' },
  story: {
    evmAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    chainId: 'aeneid' as const,
    rpcUrl: 'http://rpc.invalid',
  },
  ipfs: {},
  volemApiUrl: 'http://volem.invalid',
};

after(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

const preparedOperation = {
  operationId: 'operation-1',
  attemptId: 'attempt-1',
  kind: 'MERGE',
  status: 'PREPARED',
  chainId: 1315,
  senderAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const,
  target: '0x0000000000000000000000000000000000000002' as const,
  calldata: '0x1234' as const,
  transactionValue: '5',
  senderNonce: '7',
  txHash: null,
  reconciliationOutcome: null,
  requiresReconciliation: false,
};

const actionFrom = (init?: RequestInit): string =>
  (JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { action: string }).action;

describe('acceptance broadcast orchestration', () => {
  it('fsyncs exact intent before send and records the returned hash', async () => {
    const originalFetch = globalThis.fetch;
    const journal = new VolemRequestJournal(join(testHome, 'success-journal.jsonl'));
    const actions: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const action = actionFrom(init);
      actions.push(action);
      return Response.json(
        action === 'prepare'
          ? { success: true, operation: preparedOperation }
          : { success: true, operation: { ...preparedOperation, status: 'SUBMITTED' } },
      );
    };
    try {
      const result = await prepareBroadcastAndRecord({
        config,
        attemptId: 'attempt-1',
        journal,
        sendTransaction: async () => {
          assert.equal(journal.events().some((event) => event.type === 'BROADCAST_INTENT'), true);
          assert.equal(journal.events().some((event) => event.type === 'BROADCAST_HASH'), false);
          return `0x${'ab'.repeat(32)}`;
        },
      });
      assert.equal(result.phase, 'RECORDED');
      assert.equal(result.txHash, `0x${'ab'.repeat(32)}`);
      assert.deepEqual(actions, ['prepare', 'record']);
      assert.equal(journal.events().some((event) => event.type === 'BROADCAST_HASH'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reconciles after an ambiguous wallet failure and never sends twice', async () => {
    const originalFetch = globalThis.fetch;
    const journal = new VolemRequestJournal(join(testHome, 'unknown-journal.jsonl'));
    const actions: string[] = [];
    let sends = 0;
    globalThis.fetch = async (_input, init) => {
      const action = actionFrom(init);
      actions.push(action);
      return Response.json(
        action === 'prepare'
          ? { success: true, operation: preparedOperation }
          : { success: true, operation: preparedOperation, outcome: 'ABSENT', readyToSubmit: true },
      );
    };
    try {
      const result = await prepareBroadcastAndRecord({
        config,
        attemptId: 'attempt-1',
        journal,
        sendTransaction: async () => {
          sends += 1;
          throw new Error('RPC response lost');
        },
      });
      assert.equal(result.phase, 'RECONCILIATION_REQUIRED');
      assert.equal(sends, 1);
      assert.deepEqual(actions, ['prepare', 'reconcile']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not call the wallet when durable intent persistence fails', async () => {
    const originalFetch = globalThis.fetch;
    class FailingJournal extends VolemRequestJournal {
      override recordBroadcastIntent(): void {
        throw new Error('fsync failed');
      }
    }
    globalThis.fetch = async () => Response.json({ success: true, operation: preparedOperation });
    let sends = 0;
    try {
      await assert.rejects(
        prepareBroadcastAndRecord({
          config,
          attemptId: 'attempt-1',
          journal: new FailingJournal(join(testHome, 'failed-journal.jsonl')),
          sendTransaction: async () => {
            sends += 1;
            return `0x${'cd'.repeat(32)}`;
          },
        }),
        /fsync failed/,
      );
      assert.equal(sends, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('offers an unresolved restart recovery before another prepare or send', async () => {
    const originalFetch = globalThis.fetch;
    const journal = new VolemRequestJournal(join(testHome, 'restart-journal.jsonl'));
    const request = journal.beginHttpRequest(
      'acceptance.prepare',
      new TextEncoder().encode('{"action":"prepare","attemptId":"attempt-1"}'),
    );
    journal.recordBroadcastIntent({
      requestId: request.requestId,
      attemptId: 'attempt-1',
      operationId: 'operation-1',
      sender: preparedOperation.senderAddress,
      transactionNonce: preparedOperation.senderNonce,
      target: preparedOperation.target,
      calldataHash: `0x${'ef'.repeat(32)}`,
      value: preparedOperation.transactionValue,
    });
    let fetched = false;
    let sent = false;
    globalThis.fetch = async () => {
      fetched = true;
      return Response.json({ success: true });
    };
    try {
      const result = await prepareBroadcastAndRecord({
        config,
        attemptId: 'attempt-1',
        journal,
        sendTransaction: async () => {
          sent = true;
          return `0x${'aa'.repeat(32)}`;
        },
      });
      assert.equal(result.phase, 'RECONCILIATION_REQUIRED');
      assert.equal(result.operationId, 'operation-1');
      assert.equal(fetched, false);
      assert.equal(sent, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
