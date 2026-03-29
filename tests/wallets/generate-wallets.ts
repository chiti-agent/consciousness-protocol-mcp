/**
 * Generate 8 deterministic EVM wallets for testing.
 * Derives private keys from SHA-256(seed + index) for reproducibility.
 * Saves keys to ~/.consciousness-protocol/keys/test-{name}.json
 *
 * Run: node --import tsx/esm tests/wallets/generate-wallets.ts
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SEED = 'consciousness-protocol-test-wallets-v1';

export const TEST_AGENTS = [
  'test-poet',
  'test-developer',
  'test-skill-maker',
  'test-mcp-maker',
  'test-artist',
  'test-musician',
  'test-inventor',
  'test-buyer',
] as const;

export type TestAgentName = (typeof TEST_AGENTS)[number];

export interface TestWallet {
  name: TestAgentName;
  address: string;
  privateKey: `0x${string}`;
}

const KEYS_DIR = join(homedir(), '.consciousness-protocol', 'keys');

function deriveKey(index: number): `0x${string}` {
  const hash = createHash('sha256')
    .update(`${SEED}:${index}`)
    .digest('hex');
  return `0x${hash}`;
}

export function generateWallets(): TestWallet[] {
  const wallets: TestWallet[] = [];

  for (let i = 0; i < TEST_AGENTS.length; i++) {
    const privateKey = deriveKey(i);
    const account = privateKeyToAccount(privateKey);

    wallets.push({
      name: TEST_AGENTS[i],
      address: account.address,
      privateKey,
    });
  }

  return wallets;
}

export function saveWallets(wallets: TestWallet[]): void {
  mkdirSync(KEYS_DIR, { recursive: true });
  try { chmodSync(KEYS_DIR, 0o700); } catch { /* ok on some OS */ }

  for (const w of wallets) {
    const keyFile = join(KEYS_DIR, `${w.name}.json`);
    writeFileSync(keyFile, JSON.stringify({
      privateKey: w.privateKey,
      address: w.address,
      savedAt: new Date().toISOString(),
      note: 'Test wallet — do NOT use for real funds',
    }, null, 2), { mode: 0o600 });
  }
}

// --- Main ---

function main(): void {
  console.log('Generating 8 deterministic test wallets...');
  console.log();

  const wallets = generateWallets();
  saveWallets(wallets);

  console.log('Test wallets:');
  console.log();
  for (const w of wallets) {
    console.log(`  ${w.name.padEnd(20)} ${w.address}`);
  }
  console.log();
  console.log(`Keys saved to: ${KEYS_DIR}/test-*.json`);
}

main();
