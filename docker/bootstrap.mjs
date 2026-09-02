#!/usr/bin/env node
/**
 * Hosted-container bootstrap. It writes read-only public configuration and
 * deliberately never imports setupAgent or handles wallet private keys.
 */
import { loadConfig, saveConfig } from '../dist/config/store.js';

const env = process.env;
const network = env.CP_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

if (!env.CP_NEAR_ACCOUNT && !env.CP_EVM_ADDRESS) {
  try {
    const existing = loadConfig();
    console.error(
      `[bootstrap] Using existing keyless config for ${existing.near.accountId} (network=${existing.network}).`,
    );
    process.exit(0);
  } catch {
    console.error('[bootstrap] FATAL: CP_NEAR_ACCOUNT and CP_EVM_ADDRESS are required on a fresh hosted volume.');
    process.exit(1);
  }
}

const missing = ['CP_NEAR_ACCOUNT', 'CP_EVM_ADDRESS'].filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`[bootstrap] FATAL: missing required public config: ${missing.join(', ')}`);
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(env.CP_EVM_ADDRESS)) {
  console.error('[bootstrap] FATAL: CP_EVM_ADDRESS must be a 20-byte hexadecimal address.');
  process.exit(1);
}

const explicitBackend = env.CP_BACKEND;
const backend =
  explicitBackend === 'volem' || explicitBackend === 'story' || explicitBackend === 'local'
    ? explicitBackend
    : env.CP_STORY_API_KEY
      ? 'story'
      : 'local';

saveConfig({
  network,
  near: {
    accountId: env.CP_NEAR_ACCOUNT,
    registryContract: network === 'testnet' ? 'consciousness-protocol.testnet' : 'consciousness-protocol.near',
  },
  story: {
    evmAddress: env.CP_EVM_ADDRESS,
    chainId: network === 'testnet' ? 'aeneid' : 'mainnet',
    rpcUrl: network === 'testnet' ? 'https://aeneid.storyrpc.io' : 'https://mainnet.storyrpc.io',
  },
  ipfs: {},
  backend,
  ...(env.CP_VOLEM_API_URL ? { volemApiUrl: env.CP_VOLEM_API_URL } : {}),
  ...(env.CP_STORY_API_KEY ? { storyApiKey: env.CP_STORY_API_KEY } : {}),
});

console.error(
  `[bootstrap] Provisioned keyless hosted config for ${env.CP_NEAR_ACCOUNT} (network=${network}, backend=${backend}).`,
);
