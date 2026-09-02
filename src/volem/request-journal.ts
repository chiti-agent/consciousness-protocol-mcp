import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONFIG_DIR } from '../config/store.js';
import { evm2BodySha256, newEvm2RequestIdentity, type Evm2Action, type Evm2RequestIdentity } from './evm2.js';

export type HttpRequestStarted = {
  type: 'HTTP_REQUEST_STARTED';
  requestId: string;
  action: Evm2Action;
  bodySha256: `0x${string}`;
  canonicalBodyBase64: string;
  idempotencyKey: string;
  createdAt: string;
};

export type HttpRequestAttempt = {
  type: 'HTTP_REQUEST_ATTEMPT';
  requestId: string;
  signatureNonce: `0x${string}`;
  createdAt: string;
};

export type ActiveHttpRequest = HttpRequestStarted & { signatureNonce: `0x${string}` };

export type BroadcastIntent = {
  type: 'BROADCAST_INTENT';
  requestId: string;
  operationId: string;
  sender: `0x${string}`;
  transactionNonce: string;
  target: `0x${string}`;
  calldataHash: `0x${string}`;
  value: string;
  createdAt: string;
};

export type BroadcastHash = {
  type: 'BROADCAST_HASH';
  requestId: string;
  operationId: string;
  transactionHash: `0x${string}`;
  createdAt: string;
};

export type RequestTerminal = {
  type: 'REQUEST_TERMINAL';
  requestId: string;
  outcome: 'SUCCEEDED' | 'FAILED';
  createdAt: string;
};

export type JournalEvent = HttpRequestStarted | HttpRequestAttempt | BroadcastIntent | BroadcastHash | RequestTerminal;

const JOURNAL_FILE = join(CONFIG_DIR, 'volem-request-journal.jsonl');

const nowIso = () => new Date().toISOString();

export class VolemRequestJournal {
  constructor(readonly file = JOURNAL_FILE) {}

  append(event: JournalEvent): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const descriptor = openSync(this.file, 'a', 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  events(): JournalEvent[] {
    if (!existsSync(this.file)) return [];
    const source = readFileSync(this.file, 'utf8');
    const lines = source.split('\n');
    const events: JournalEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch (error) {
        const isTrailingPartial = index === lines.length - 1 && !source.endsWith('\n');
        if (!isTrailingPartial) throw new Error(`Invalid request journal row ${index + 1}.`, { cause: error });
      }
    }
    return events;
  }

  beginHttpRequest(action: Evm2Action, body: Uint8Array): ActiveHttpRequest {
    const bodySha256 = evm2BodySha256(body);
    const events = this.events();
    const terminals = new Set(
      events.filter((event): event is RequestTerminal => event.type === 'REQUEST_TERMINAL').map((event) => event.requestId),
    );
    const existing = [...events]
      .reverse()
      .find(
        (event): event is HttpRequestStarted =>
          event.type === 'HTTP_REQUEST_STARTED' &&
          event.action === action &&
          event.bodySha256 === bodySha256 &&
          !terminals.has(event.requestId),
      );
    const started = existing ?? (() => {
      const created: HttpRequestStarted = {
        type: 'HTTP_REQUEST_STARTED',
        requestId: randomUUID(),
        action,
        bodySha256,
        canonicalBodyBase64: Buffer.from(body).toString('base64'),
        idempotencyKey: newEvm2RequestIdentity().idempotencyKey,
        createdAt: nowIso(),
      };
      this.append(created);
      return created;
    })();
    const signatureNonce = newEvm2RequestIdentity().nonce;
    this.append({ type: 'HTTP_REQUEST_ATTEMPT', requestId: started.requestId, signatureNonce, createdAt: nowIso() });
    return { ...started, signatureNonce };
  }

  identity(request: ActiveHttpRequest): Evm2RequestIdentity {
    return { nonce: request.signatureNonce, idempotencyKey: request.idempotencyKey };
  }

  recordBroadcastIntent(event: Omit<BroadcastIntent, 'type' | 'createdAt'>): void {
    this.append({ type: 'BROADCAST_INTENT', ...event, createdAt: nowIso() });
  }

  recordBroadcastHash(event: Omit<BroadcastHash, 'type' | 'createdAt'>): void {
    this.append({ type: 'BROADCAST_HASH', ...event, createdAt: nowIso() });
  }

  markTerminal(requestId: string, outcome: RequestTerminal['outcome']): void {
    this.append({ type: 'REQUEST_TERMINAL', requestId, outcome, createdAt: nowIso() });
  }
}

export const defaultVolemRequestJournal = new VolemRequestJournal();
