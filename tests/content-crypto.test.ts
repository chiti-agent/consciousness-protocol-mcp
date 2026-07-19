/**
 * Unit tests for content-crypto — the license-gated content encryption.
 * Blob layout: [ IV (12) | ciphertext | GCM tag (16) ].
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encryptContent, decryptContent, ENCRYPTED_MIME } from '../src/content-crypto.js';

describe('content-crypto', () => {
  it('roundtrips text content', () => {
    const plain = Buffer.from('Скрытый скилл: как считать роялти в уме', 'utf-8');
    const { blob, keyHex } = encryptContent(plain);
    assert.notEqual(blob.toString('hex'), plain.toString('hex'));
    assert.equal(keyHex.length, 64);
    assert.deepEqual(decryptContent(blob, keyHex), plain);
  });

  it('roundtrips binary content', () => {
    const plain = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const { blob, keyHex } = encryptContent(plain);
    assert.equal(blob.length, 12 + plain.length + 16);
    assert.deepEqual(decryptContent(blob, keyHex), plain);
  });

  it('unique key and IV per encryption', () => {
    const plain = Buffer.from('same input');
    const a = encryptContent(plain);
    const b = encryptContent(plain);
    assert.notEqual(a.keyHex, b.keyHex);
    assert.notEqual(a.blob.toString('hex'), b.blob.toString('hex'));
  });

  it('rejects a tampered blob (GCM auth)', () => {
    const { blob, keyHex } = encryptContent(Buffer.from('integrity matters'));
    blob[14] ^= 0xff; // flip a ciphertext byte
    assert.throws(() => decryptContent(blob, keyHex));
  });

  it('rejects the wrong key', () => {
    const { blob } = encryptContent(Buffer.from('secret'));
    const wrongKey = '00'.repeat(32);
    assert.throws(() => decryptContent(blob, wrongKey));
  });

  it('rejects a too-short blob with a clear error', () => {
    assert.throws(
      () => decryptContent(Buffer.from([1, 2, 3]), '00'.repeat(32)),
      /too short/,
    );
  });

  it('rejects a malformed key with a clear error', () => {
    const { blob } = encryptContent(Buffer.from('x'));
    assert.throws(() => decryptContent(blob, 'deadbeef'), /32 bytes/);
  });

  it('exports the encrypted MIME marker', () => {
    assert.equal(ENCRYPTED_MIME, 'application/vnd.volem.encrypted');
  });
});
