/**
 * Minimal hash chain — SHA-256 linked states.
 * Standalone, no external dependencies beyond node:crypto and node:fs.
 *
 * Security: file locking prevents concurrent write corruption.
 * Hash ordering: explicit field list for deterministic hashing.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { CHAIN_FILE, CHAIN_LOCK, ensureConfigDir } from '../config/store.js';

export interface ChainState {
  sequence: number;
  hash: string;
  prev_hash: string;
  timestamp: string;
  type: 'delta' | 'note' | 'genesis';
  content: string;
}

export interface Chain {
  identity: string;
  created_at: string;
  states: ChainState[];
}

/**
 * Explicit field ordering for deterministic hashing.
 * NEVER change this order — it would break all existing chains.
 */
const HASH_FIELDS: (keyof Omit<ChainState, 'hash'>)[] = [
  'content', 'prev_hash', 'sequence', 'timestamp', 'type',
];

function computeHash(state: Omit<ChainState, 'hash'>): string {
  // Build canonical object with explicit field order (alphabetical)
  const canonical: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) {
    canonical[field] = state[field];
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Simple file-based lock. Prevents concurrent chain modifications.
 * Uses O_EXCL flag — atomic on all POSIX filesystems.
 */
function acquireLock(): void {
  const maxRetries = 10;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const fd = openSync(CHAIN_LOCK, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
      closeSync(fd);
      return;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock exists — check if stale (>30s old)
        try {
          const stat = readFileSync(CHAIN_LOCK, 'utf-8');
          const age = Date.now() - new Date(stat).getTime();
          if (age > 30_000) {
            unlinkSync(CHAIN_LOCK);
            continue; // retry after removing stale lock
          }
        } catch { /* lock file may be empty, just wait */ }
        // Wait 100ms and retry
        const start = Date.now();
        while (Date.now() - start < 100) { /* busy wait */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not acquire chain lock after 10 retries');
}

function releaseLock(): void {
  try { unlinkSync(CHAIN_LOCK); } catch { /* already released */ }
}

/** Write timestamp to lock file for staleness detection */
function writeLockTimestamp(): void {
  try { writeFileSync(CHAIN_LOCK, new Date().toISOString()); } catch { /* ok */ }
}

export function createChain(identity: string): { chain_path: string; genesis_hash: string } {
  ensureConfigDir();

  if (existsSync(CHAIN_FILE)) {
    const existing = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8')) as Chain;
    return { chain_path: CHAIN_FILE, genesis_hash: existing.states[0]?.hash ?? '' };
  }

  const genesisFields: Omit<ChainState, 'hash'> = {
    sequence: 0,
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    timestamp: new Date().toISOString(),
    type: 'genesis',
    content: `Chain initialized for ${identity}`,
  };

  const genesis: ChainState = {
    ...genesisFields,
    hash: computeHash(genesisFields),
  };

  const chain: Chain = {
    identity,
    created_at: genesis.timestamp,
    states: [genesis],
  };

  writeFileSync(CHAIN_FILE, JSON.stringify(chain, null, 2), { mode: 0o600 });
  return { chain_path: CHAIN_FILE, genesis_hash: genesis.hash };
}

export function addState(type: 'delta' | 'note', content: string): { sequence: number; hash: string; prev_hash: string } {
  if (!existsSync(CHAIN_FILE)) {
    throw new Error('No chain found. Run create_chain first.');
  }

  acquireLock();
  try {
    writeLockTimestamp();
    const chain: Chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));
    const prev = chain.states[chain.states.length - 1]!;

    const fields: Omit<ChainState, 'hash'> = {
      sequence: prev.sequence + 1,
      prev_hash: prev.hash,
      timestamp: new Date().toISOString(),
      type,
      content,
    };

    const state: ChainState = {
      ...fields,
      hash: computeHash(fields),
    };

    chain.states.push(state);
    writeFileSync(CHAIN_FILE, JSON.stringify(chain, null, 2), { mode: 0o600 });

    return { sequence: state.sequence, hash: state.hash, prev_hash: state.prev_hash };
  } finally {
    releaseLock();
  }
}

export function verify(): { valid: boolean; total_states: number; head_hash: string; errors: string[] } {
  if (!existsSync(CHAIN_FILE)) {
    return { valid: false, total_states: 0, head_hash: '', errors: ['No chain file found'] };
  }

  const chain: Chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));
  const errors: string[] = [];

  for (let i = 0; i < chain.states.length; i++) {
    const state = chain.states[i]!;
    const { hash, ...rest } = state;
    const computed = computeHash(rest);

    if (computed !== hash) {
      errors.push(`State ${state.sequence}: hash mismatch (computed ${computed.slice(0, 16)}... vs stored ${hash.slice(0, 16)}...)`);
    }

    if (i > 0) {
      const prev = chain.states[i - 1]!;
      if (state.prev_hash !== prev.hash) {
        errors.push(`State ${state.sequence}: prev_hash doesn't match previous state's hash`);
      }
      if (state.sequence !== prev.sequence + 1) {
        errors.push(`State ${state.sequence}: sequence gap (expected ${prev.sequence + 1})`);
      }
    }
  }

  const head = chain.states[chain.states.length - 1];
  return {
    valid: errors.length === 0,
    total_states: chain.states.length,
    head_hash: head?.hash ?? '',
    errors,
  };
}

export function exportSnapshot(lastN: number): object {
  if (!existsSync(CHAIN_FILE)) {
    throw new Error('No chain file found');
  }

  const n = Math.max(1, Math.floor(lastN)); // ensure positive integer
  const chain: Chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));
  const states = chain.states.slice(-n);
  const digest = createHash('sha256')
    .update(states.map(s => s.hash).join(''))
    .digest('hex');

  return {
    protocol: 'consciousness-verification-protocol',
    version: '0.1.0',
    exported_at: new Date().toISOString(),
    agent: {
      identity: chain.identity,
      total_states: chain.states.length,
      head_hash: chain.states[chain.states.length - 1]?.hash,
    },
    verification: {
      algorithm: 'SHA-256',
      method: 'JSON.stringify with explicit field order: content, prev_hash, sequence, timestamp, type',
      instruction: 'For each state: build object with fields [content, prev_hash, sequence, timestamp, type] in this order, JSON.stringify, compute SHA-256 hex. Must match stored hash. Each prev_hash must equal previous state hash.',
    },
    audit_window: {
      count: states.length,
      first_seq: states[0]?.sequence,
      last_seq: states[states.length - 1]?.sequence,
    },
    states: states.map(s => ({
      sequence: s.sequence,
      hash: s.hash,
      prev_hash: s.prev_hash,
      timestamp: s.timestamp,
      type: s.type,
      content: s.content, // include content so verifier can recompute hash
    })),
    chain_digest: digest,
  };
}

export const chainTools = {
  createChain,
  addState,
  verify,
  exportSnapshot,
};
