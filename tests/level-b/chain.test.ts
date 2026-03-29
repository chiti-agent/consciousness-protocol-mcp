/**
 * Level B integration tests for chain tools.
 * Tests actual createChain, addState, verify, exportSnapshot functions.
 *
 * Strategy: set process.env.HOME to a temp dir BEFORE importing the chain module,
 * so CHAIN_FILE resolves to the temp dir instead of the real ~/.consciousness-protocol/.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Create temp home and redirect BEFORE importing chain module
const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'chain-test-'));
process.env.HOME = TEMP_HOME;

// Now import — CHAIN_FILE will resolve under TEMP_HOME
const { createChain, addState, verify, exportSnapshot } = await import('../../src/chain/hash-chain.js');

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Level B: Chain Tools Integration', () => {
  after(() => {
    // Restore HOME and clean up temp dir
    process.env.HOME = ORIGINAL_HOME;
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  describe('createChain', () => {
    it('creates genesis state for a new agent', () => {
      const result = createChain('test-agent');

      assert.ok(result.chain_path, 'should return chain_path');
      assert.ok(result.chain_path.includes('.consciousness-protocol'), 'path should be in config dir');
      assert.ok(result.genesis_hash, 'should return genesis_hash');
      assert.equal(result.genesis_hash.length, 64, 'genesis hash should be SHA-256 hex');
      assert.match(result.genesis_hash, /^[a-f0-9]{64}$/, 'should be valid hex');
    });

    it('returns existing chain on duplicate create (idempotent)', () => {
      const first = createChain('test-agent');
      const second = createChain('test-agent');

      assert.equal(first.genesis_hash, second.genesis_hash, 'should return same genesis hash');
      assert.equal(first.chain_path, second.chain_path, 'should return same path');
    });
  });

  describe('addState', () => {
    it('adds delta state at seq:1 with correct prev_hash', () => {
      const genesis = createChain('test-agent');
      const state1 = addState('delta', 'test content');

      assert.equal(state1.sequence, 1, 'should be sequence 1');
      assert.equal(state1.prev_hash, genesis.genesis_hash, 'prev_hash should match genesis hash');
      assert.equal(state1.hash.length, 64, 'hash should be SHA-256 hex');
      assert.notEqual(state1.hash, state1.prev_hash, 'hash should differ from prev_hash');
    });

    it('adds note state at seq:2, linked to seq:1', () => {
      const state2 = addState('note', 'observation');

      assert.equal(state2.sequence, 2, 'should be sequence 2');
      assert.equal(state2.hash.length, 64, 'hash should be SHA-256 hex');
      // prev_hash of seq:2 should be the hash of seq:1
      // We can verify this through the verify function
    });

    it('throws if no chain exists', () => {
      const chainPath = join(TEMP_HOME, '.consciousness-protocol', 'chain.json');
      const backup = readFileSync(chainPath, 'utf-8');

      unlinkSync(chainPath);
      assert.throws(() => addState('note', 'should fail'), /No chain found/);

      // Restore
      writeFileSync(chainPath, backup);
    });
  });

  describe('verify', () => {
    it('confirms chain integrity after multiple additions', () => {
      const result = verify();

      assert.equal(result.valid, true, 'chain should be valid');
      assert.equal(result.total_states, 3, 'should have 3 states (genesis + 2 added)');
      assert.equal(result.errors.length, 0, 'should have no errors');
      assert.equal(result.head_hash.length, 64, 'head hash should be valid');
    });
  });

  describe('exportSnapshot', () => {
    it('exports last N states with verification info', () => {
      const snapshot = exportSnapshot(5) as any;

      assert.equal(snapshot.protocol, 'consciousness-verification-protocol');
      assert.equal(snapshot.version, '0.1.0');
      assert.ok(snapshot.verification, 'should include verification instructions');
      assert.equal(snapshot.verification.algorithm, 'SHA-256');
      assert.ok(snapshot.verification.method.includes('explicit field order'));

      assert.equal(snapshot.agent.identity, 'test-agent');
      assert.equal(snapshot.agent.total_states, 3);

      assert.equal(snapshot.audit_window.count, 3, 'all 3 states fit in window of 5');
      assert.equal(snapshot.audit_window.first_seq, 0);
      assert.equal(snapshot.audit_window.last_seq, 2);

      assert.equal(snapshot.states.length, 3);
      assert.ok(snapshot.chain_digest, 'should include chain digest');
      assert.equal(snapshot.chain_digest.length, 64);
    });

    it('exports only last 1 state when requested', () => {
      const snapshot = exportSnapshot(1) as any;

      assert.equal(snapshot.audit_window.count, 1);
      assert.equal(snapshot.states.length, 1);
      assert.equal(snapshot.states[0].sequence, 2, 'should be the latest state');
    });

    it('states in snapshot have all required fields', () => {
      const snapshot = exportSnapshot(5) as any;

      for (const state of snapshot.states) {
        assert.ok('sequence' in state, 'should have sequence');
        assert.ok('hash' in state, 'should have hash');
        assert.ok('prev_hash' in state, 'should have prev_hash');
        assert.ok('timestamp' in state, 'should have timestamp');
        assert.ok('type' in state, 'should have type');
        assert.ok('content' in state, 'should have content');
      }
    });
  });
});
