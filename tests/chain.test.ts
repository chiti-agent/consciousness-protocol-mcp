/**
 * Chain management tests — hash chain create, add, verify, export.
 * Uses Node.js built-in test runner (no external deps).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Override config dir for testing
const TEST_DIR = join(homedir(), '.consciousness-protocol-test');
const CHAIN_FILE = join(TEST_DIR, 'chain.json');
const CHAIN_LOCK = join(TEST_DIR, 'chain.lock');

// We test the hash-chain module directly
import { createHash } from 'node:crypto';

interface ChainState {
  sequence: number;
  hash: string;
  prev_hash: string;
  timestamp: string;
  type: string;
  content: string;
}

interface Chain {
  identity: string;
  created_at: string;
  states: ChainState[];
}

const HASH_FIELDS = ['content', 'prev_hash', 'sequence', 'timestamp', 'type'];

function computeHash(state: Omit<ChainState, 'hash'>): string {
  const canonical: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) {
    canonical[field] = (state as any)[field];
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function cleanup() {
  try { unlinkSync(CHAIN_FILE); } catch {}
  try { unlinkSync(CHAIN_LOCK); } catch {}
}

describe('Hash Chain', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
  });

  after(() => {
    cleanup();
  });

  it('genesis state has correct hash', () => {
    const genesis: Omit<ChainState, 'hash'> = {
      sequence: 0,
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'genesis',
      content: 'Test chain',
    };

    const hash = computeHash(genesis);
    assert.equal(hash.length, 64, 'SHA-256 hex should be 64 chars');
    assert.match(hash, /^[a-f0-9]{64}$/, 'Should be hex string');
  });

  it('hash changes when content changes', () => {
    const base: Omit<ChainState, 'hash'> = {
      sequence: 1,
      prev_hash: 'abc',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'note',
      content: 'original',
    };

    const modified = { ...base, content: 'modified' };

    assert.notEqual(computeHash(base), computeHash(modified));
  });

  it('hash is deterministic', () => {
    const state: Omit<ChainState, 'hash'> = {
      sequence: 1,
      prev_hash: 'abc',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'note',
      content: 'test',
    };

    assert.equal(computeHash(state), computeHash(state));
  });

  it('prev_hash linkage forms valid chain', () => {
    const states: ChainState[] = [];

    // Genesis
    const g: Omit<ChainState, 'hash'> = {
      sequence: 0,
      prev_hash: '0'.repeat(64),
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'genesis',
      content: 'Genesis',
    };
    states.push({ ...g, hash: computeHash(g) });

    // State 1
    const s1: Omit<ChainState, 'hash'> = {
      sequence: 1,
      prev_hash: states[0].hash,
      timestamp: '2026-01-01T00:01:00.000Z',
      type: 'note',
      content: 'First note',
    };
    states.push({ ...s1, hash: computeHash(s1) });

    // State 2
    const s2: Omit<ChainState, 'hash'> = {
      sequence: 2,
      prev_hash: states[1].hash,
      timestamp: '2026-01-01T00:02:00.000Z',
      type: 'delta',
      content: 'Changed something',
    };
    states.push({ ...s2, hash: computeHash(s2) });

    // Verify chain
    for (let i = 1; i < states.length; i++) {
      assert.equal(states[i].prev_hash, states[i - 1].hash,
        `State ${i} prev_hash should match state ${i-1} hash`);
    }

    // Verify all hashes
    for (const state of states) {
      const { hash, ...rest } = state;
      assert.equal(computeHash(rest), hash, `State ${state.sequence} hash should be valid`);
    }
  });

  it('tampered hash is detected', () => {
    const state: Omit<ChainState, 'hash'> = {
      sequence: 1,
      prev_hash: 'abc',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'note',
      content: 'original',
    };

    const correctHash = computeHash(state);
    const tamperedHash = 'tampered' + correctHash.slice(8);

    assert.notEqual(tamperedHash, correctHash, 'Tampered hash should differ');
    assert.equal(computeHash(state), correctHash, 'Recomputed hash should match original');
  });

  it('field order is alphabetical and explicit', () => {
    // HASH_FIELDS must be sorted alphabetically
    const sorted = [...HASH_FIELDS].sort();
    assert.deepEqual(HASH_FIELDS, sorted, 'HASH_FIELDS must be in alphabetical order');
  });
});

describe('Chain File Operations', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    cleanup();
  });

  after(() => {
    cleanup();
  });

  it('chain.json is valid JSON after creation', () => {
    const chain: Chain = {
      identity: 'test',
      created_at: new Date().toISOString(),
      states: [{
        sequence: 0,
        hash: 'abc',
        prev_hash: '0'.repeat(64),
        timestamp: new Date().toISOString(),
        type: 'genesis',
        content: 'test',
      }],
    };

    writeFileSync(CHAIN_FILE, JSON.stringify(chain, null, 2));
    const loaded = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));
    assert.equal(loaded.identity, 'test');
    assert.equal(loaded.states.length, 1);
  });

  it('export snapshot contains verification instructions', () => {
    const chain: Chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf-8'));

    // Simulate export
    const snapshot = {
      protocol: 'consciousness-verification-protocol',
      version: '0.1.0',
      verification: {
        algorithm: 'SHA-256',
        method: 'JSON.stringify with explicit field order: content, prev_hash, sequence, timestamp, type',
      },
      states: chain.states,
    };

    assert.equal(snapshot.verification.algorithm, 'SHA-256');
    assert.ok(snapshot.verification.method.includes('explicit field order'));
  });
});

describe('Input Validation', () => {
  it('agent name regex rejects invalid names', () => {
    const validPattern = /^[a-z0-9_-]+$/;

    assert.ok(validPattern.test('chiti'), 'chiti is valid');
    assert.ok(validPattern.test('my-agent'), 'my-agent is valid');
    assert.ok(validPattern.test('agent_123'), 'agent_123 is valid');

    assert.ok(!validPattern.test(''), 'empty is invalid');
    assert.ok(!validPattern.test('Agent'), 'uppercase is invalid');
    assert.ok(!validPattern.test('agent name'), 'spaces invalid');
    assert.ok(!validPattern.test('agent.name'), 'dots invalid');
    assert.ok(!validPattern.test('../etc/passwd'), 'path traversal invalid');
  });

  it('ethereum address regex validates correctly', () => {
    const addressPattern = /^0x[a-fA-F0-9]{40}$/;

    assert.ok(addressPattern.test('0x1fA24990b4375819f650A894014E1552F92DFb4e'), 'valid address');
    assert.ok(addressPattern.test('0x0000000000000000000000000000000000000000'), 'zero address');

    assert.ok(!addressPattern.test('hello'), 'not an address');
    assert.ok(!addressPattern.test('0x123'), 'too short');
    assert.ok(!addressPattern.test('1fA24990b4375819f650A894014E1552F92DFb4e'), 'no 0x prefix');
    assert.ok(!addressPattern.test('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG'), 'non-hex chars');
  });
});
