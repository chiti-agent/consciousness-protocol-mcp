/**
 * Minimal hash chain — SHA-256 linked states.
 * Standalone, no external dependencies.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CHAIN_FILE, ensureConfigDir } from '../config/store.js';

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

function computeHash(state: Omit<ChainState, 'hash'>): string {
  const canonical = JSON.stringify(state, Object.keys(state).sort());
  return createHash('sha256').update(canonical).digest('hex');
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

  writeFileSync(CHAIN_FILE, JSON.stringify(chain, null, 2));
  return { chain_path: CHAIN_FILE, genesis_hash: genesis.hash };
}

export function addState(type: 'delta' | 'note', content: string): { sequence: number; hash: string; prev_hash: string } {
  if (!existsSync(CHAIN_FILE)) {
    throw new Error('No chain found. Run create_chain first.');
  }

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
  writeFileSync(CHAIN_FILE, JSON.stringify(chain, null, 2));

  return { sequence: state.sequence, hash: state.hash, prev_hash: state.prev_hash };
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

  const chain: Chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));
  const states = chain.states.slice(-lastN);
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
      method: 'JSON.stringify(state_without_hash, sorted_keys)',
      instruction: 'For each state: remove "hash" field, JSON.stringify remaining fields with sorted keys, compute SHA-256. Must match stored hash. Each prev_hash must equal previous state hash.',
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
    })),
    chain_digest: digest,
  };
}

// Convenience object for tool registration
export const chainTools = {
  createChain,
  addState,
  verify,
  exportSnapshot,
};
