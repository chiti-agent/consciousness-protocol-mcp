import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { VolemRequestJournal } from '../src/volem/request-journal.js';

const directories: string[] = [];
const journal = () => {
  const directory = mkdtempSync(join(tmpdir(), 'volem-journal-'));
  directories.push(directory);
  return new VolemRequestJournal(join(directory, 'journal.jsonl'));
};

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('durable Volem request journal', () => {
  it('reuses one logical idempotency key with a fresh replay nonce per HTTP attempt', () => {
    const store = journal();
    const body = new TextEncoder().encode('{"title":"same intent"}');
    const first = store.beginHttpRequest('thread.create', body);
    const retry = store.beginHttpRequest('thread.create', body);
    assert.equal(retry.requestId, first.requestId);
    assert.equal(retry.idempotencyKey, first.idempotencyKey);
    assert.notEqual(retry.signatureNonce, first.signatureNonce);
    store.markHttpTerminal(first.requestId, 'SUCCEEDED');
    assert.notEqual(store.beginHttpRequest('thread.create', body).requestId, first.requestId);
  });

  it('records exact broadcast identity before a hash', () => {
    const store = journal();
    const started = store.beginHttpRequest('acceptance.prepare', new TextEncoder().encode('{"action":"prepare"}'));
    store.recordBroadcastIntent({
      requestId: started.requestId,
      attemptId: 'attempt-1',
      operationId: 'operation-1',
      sender: '0x0000000000000000000000000000000000000001',
      transactionNonce: '7',
      target: '0x0000000000000000000000000000000000000002',
      calldataHash: `0x${'ab'.repeat(32)}`,
      value: '0',
    });
    assert.deepEqual(store.events().map((event) => event.type), [
      'HTTP_REQUEST_STARTED',
      'HTTP_REQUEST_ATTEMPT',
      'BROADCAST_INTENT',
    ]);
    assert.match(readFileSync(store.file, 'utf8'), /"transactionNonce":"7"/);
    assert.deepEqual(store.pendingBroadcasts().map((entry) => entry.recoveryAction), ['reconcile']);

    store.recordBroadcastHash({
      requestId: started.requestId,
      operationId: 'operation-1',
      transactionHash: `0x${'cd'.repeat(32)}`,
    });
    assert.deepEqual(store.pendingBroadcasts().map((entry) => entry.recoveryAction), ['record']);

    store.markBroadcastTerminal(started.requestId, 'operation-1', 'RECORDED');
    assert.deepEqual(store.pendingBroadcasts(), []);
  });
});
