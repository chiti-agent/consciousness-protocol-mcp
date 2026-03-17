/**
 * Config store — reads/writes ~/.consciousness-protocol/
 *
 * Security: key files written with 0o600 (owner only), keys dir with 0o700.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_DIR = join(homedir(), '.consciousness-protocol');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const KEYS_DIR = join(CONFIG_DIR, 'keys');
export const CHAIN_FILE = join(CONFIG_DIR, 'chain.json');
export const CHAIN_LOCK = join(CONFIG_DIR, 'chain.lock');
export const REGISTRATIONS_FILE = join(CONFIG_DIR, 'registrations.json');

export interface Config {
  network: 'testnet' | 'mainnet';
  near: {
    accountId: string;
    registryContract: string;
  };
  story: {
    evmAddress: string;
    spgNftContract?: string;
    chainId: 'aeneid' | 'mainnet';
    rpcUrl: string;
  };
  ipfs: {
    pinataJwt?: string;
    gateway?: string;
  };
  /** Backend for search/showcase: volem (default), story (direct API), local (registrations.json only) */
  backend?: 'volem' | 'story' | 'local';
  /** Volem API URL (when backend=volem) */
  volemApiUrl?: string;
  /** Story Protocol API key (when backend=story) */
  storyApiKey?: string;
}

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  // Ensure permissions even if dirs already existed
  try { chmodSync(KEYS_DIR, 0o700); } catch { /* ok if fails on some OS */ }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error('Not configured. Run setup first.');
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadKey(name: string): string {
  const keyFile = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(keyFile)) {
    throw new Error(`Key not found: ${name}. Run setup first.`);
  }
  const data = JSON.parse(readFileSync(keyFile, 'utf-8'));
  return data.privateKey;
}

export function saveKey(name: string, privateKey: string): void {
  ensureConfigDir();
  const keyFile = join(KEYS_DIR, `${name}.json`);
  writeFileSync(keyFile, JSON.stringify({ privateKey, savedAt: new Date().toISOString() }), { mode: 0o600 });
}

/** Validate Ethereum hex address format */
export function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}
