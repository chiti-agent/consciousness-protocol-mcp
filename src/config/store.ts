/**
 * Config store — reads/writes ~/.consciousness-protocol/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_DIR = join(homedir(), '.consciousness-protocol');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const KEYS_DIR = join(CONFIG_DIR, 'keys');
export const CHAIN_FILE = join(CONFIG_DIR, 'chain.json');
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
}

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error('Not configured. Run setup first.');
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function loadKey(name: string): string {
  const keyFile = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(keyFile)) {
    throw new Error(`Key not found: ${name}`);
  }
  const data = JSON.parse(readFileSync(keyFile, 'utf-8'));
  return data.privateKey;
}

export function saveKey(name: string, privateKey: string): void {
  ensureConfigDir();
  const keyFile = join(KEYS_DIR, `${name}.json`);
  writeFileSync(keyFile, JSON.stringify({ privateKey, savedAt: new Date().toISOString() }));
}
