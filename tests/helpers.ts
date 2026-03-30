/**
 * Shared test utilities — config loaders, wallet helpers, constants.
 * All test configs are in-memory; they do NOT touch the main config.json.
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Config } from '../src/config/store.js';
import { generateWallets, type TestAgentName, type TestWallet } from './wallets/generate-wallets.js';

// --- Constants ---

export const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
export const VOLEM_URL = process.env.VOLEM_URL ?? 'http://localhost:3005';
export const AENEID_RPC = 'https://aeneid.storyrpc.io';
export const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

const KEYS_DIR = join(homedir(), '.consciousness-protocol', 'keys');

// --- Wallet cache ---

let _wallets: TestWallet[] | null = null;

function wallets(): TestWallet[] {
  if (!_wallets) {
    _wallets = generateWallets();
  }
  return _wallets;
}

/**
 * Get a test wallet by agent name.
 * Returns address and privateKey. Deterministic — no disk read needed,
 * but we also support reading from saved key files as fallback.
 */
export function getTestWallet(agentName: TestAgentName): { address: string; privateKey: string } {
  const wallet = wallets().find((w) => w.name === agentName);
  if (!wallet) {
    throw new Error(`Unknown test agent: ${agentName}`);
  }
  return { address: wallet.address, privateKey: wallet.privateKey };
}

/**
 * Load a test Config object for a given agent.
 * In-memory only — does not write to ~/.consciousness-protocol/config.json.
 * Matches the Config interface from src/config/store.ts.
 */
export function loadTestConfig(agentName: TestAgentName): Config {
  const wallet = getTestWallet(agentName);

  // Read Pinata keys from main config. Set SKIP_PINATA=1 to disable IPFS upload.
  const { pinataJwt, pinataKeys } = process.env.SKIP_PINATA
    ? { pinataJwt: undefined, pinataKeys: undefined }
    : readPinataFromConfig();

  return {
    network: 'testnet',
    near: {
      accountId: process.env.NEAR_TEST_ACCOUNT ?? 'consciousness-test.testnet',
      registryContract: process.env.NEAR_REGISTRY ?? 'consciousness-registry.testnet',
    },
    story: {
      evmAddress: wallet.address,
      chainId: 'aeneid',
      rpcUrl: AENEID_RPC,
    },
    ipfs: {
      pinataJwt,
      pinataKeys,
      gateway: IPFS_GATEWAY,
    },
    backend: 'volem',
    volemApiUrl: VOLEM_URL,
  };
}

/**
 * Try to read Pinata JWT from the main config file (for convenience).
 * Returns undefined if not found — tests requiring IPFS will skip.
 */
function readPinataFromConfig(): { pinataJwt?: string; pinataKeys?: string[] } {
  try {
    const configPath = join(homedir(), '.consciousness-protocol', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      pinataJwt: config.ipfs?.pinataJwt,
      pinataKeys: config.ipfs?.pinataKeys,
    };
  } catch {
    return {};
  }
}

/**
 * Get the path to a fixture file.
 */
export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

/**
 * Read a text fixture file.
 */
export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf-8');
}

/**
 * Read a binary fixture file.
 */
export function readFixtureBuffer(name: string): Buffer {
  return readFileSync(fixturePath(name));
}

const EVM_KEY_PATH = join(KEYS_DIR, 'evm.json');
const EVM_BACKUP_PATH = join(KEYS_DIR, 'evm.original.json');

/**
 * Activate a test wallet by writing its private key to the keys dir.
 * This makes `loadKey('evm')` inside tools return the correct key.
 * Call this before invoking any tool that uses `loadKey('evm')`.
 * Backs up the original key on first call.
 */
export function activateTestWallet(agentName: TestAgentName): void {
  const wallet = getTestWallet(agentName);
  mkdirSync(KEYS_DIR, { recursive: true });
  // Backup original key on first activation
  if (existsSync(EVM_KEY_PATH) && !existsSync(EVM_BACKUP_PATH)) {
    copyFileSync(EVM_KEY_PATH, EVM_BACKUP_PATH);
  }
  writeFileSync(
    EVM_KEY_PATH,
    JSON.stringify({ privateKey: wallet.privateKey, address: wallet.address }),
    { mode: 0o600 },
  );
}

/**
 * Restore the original EVM key after tests.
 * Call this in after() hooks.
 */
export function restoreOriginalWallet(): void {
  if (existsSync(EVM_BACKUP_PATH)) {
    copyFileSync(EVM_BACKUP_PATH, EVM_KEY_PATH);
    unlinkSync(EVM_BACKUP_PATH);
  }
}

/**
 * Create a StoryClient for a test agent (bypasses loadKey entirely).
 */
export async function createTestStoryClient(agentName: TestAgentName) {
  const wallet = getTestWallet(agentName);
  const { StoryClient } = await import('@story-protocol/core-sdk');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { http } = await import('viem');

  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
  return StoryClient.newClient({
    account,
    transport: http(AENEID_RPC),
    chainId: 'aeneid',
  });
}

// Re-export types and constants for convenience
export { TEST_AGENTS, type TestAgentName, type TestWallet } from './wallets/generate-wallets.js';
