/**
 * Symmetric encryption for license-gated content.
 *
 * Blob layout: [ IV (12 bytes) | ciphertext | GCM auth tag (16 bytes) ].
 * The AES-256 key (64 hex chars) is stored by Volem and released via
 * POST /api/ip/[ipId]/content-key to the owner, license-token holders and
 * derivative owners. Content on IPFS is public bytes — the key is the gate.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENCRYPTED_MIME = 'application/vnd.volem.encrypted';

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptContent(plaintext: Buffer): { blob: Buffer; keyHex: string } {
  const key = randomBytes(32);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    blob: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]),
    keyHex: key.toString('hex'),
  };
}

export function decryptContent(blob: Buffer, keyHex: string): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error(`Encrypted blob too short (${blob.length} bytes) — not a valid [iv|ciphertext|tag] payload`);
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Content key must be 32 bytes (64 hex chars)');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
