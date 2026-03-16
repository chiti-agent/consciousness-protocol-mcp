/**
 * Setup tool — creates or imports NEAR account + EVM wallet + IPFS config.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { saveConfig, saveKey, loadKey, ensureConfigDir, type Config } from '../config/store.js';

interface SetupParams {
  agent_name: string;
  network: 'testnet' | 'mainnet';
  near_account?: string;
  near_private_key?: string;
  evm_private_key?: string;
  pinata_jwt?: string;
}

export async function setupAgent(params: SetupParams): Promise<object> {
  ensureConfigDir();

  const network = params.network ?? 'testnet';
  const registryContract = network === 'testnet'
    ? 'consciousness-protocol.testnet'
    : 'consciousness-protocol.near';

  // NEAR account
  let nearAccountId: string;
  if (params.near_account) {
    nearAccountId = params.near_account;
    if (params.near_private_key) {
      saveKey('near', params.near_private_key);
    }
  } else {
    // Create new NEAR account (will need near-cli or API call)
    nearAccountId = `${params.agent_name}.${registryContract}`;
    // TODO: actually create account via NEAR API
    // For now, save placeholder
  }

  // EVM wallet for Story Protocol
  let evmAddress: string;
  if (params.evm_private_key) {
    const account = privateKeyToAccount(params.evm_private_key as `0x${string}`);
    evmAddress = account.address;
    saveKey('evm', params.evm_private_key);
  } else {
    // Check if key already exists (don't overwrite — would lose funded wallet)
    try {
      const existingKey = loadKey('evm');
      const existingAccount = privateKeyToAccount(existingKey as `0x${string}`);
      evmAddress = existingAccount.address;
    } catch {
      // No existing key — generate new one
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      evmAddress = account.address;
      saveKey('evm', pk);
    }
  }

  // Story Protocol config
  const storyChainId = network === 'testnet' ? 'aeneid' as const : 'mainnet' as const;
  const storyRpc = network === 'testnet'
    ? 'https://aeneid.storyrpc.io'
    : 'https://mainnet.storyrpc.io';

  const config: Config = {
    network,
    near: {
      accountId: nearAccountId,
      registryContract,
    },
    story: {
      evmAddress,
      chainId: storyChainId,
      rpcUrl: storyRpc,
    },
    ipfs: {
      pinataJwt: params.pinata_jwt,
    },
  };

  saveConfig(config);

  return {
    status: 'configured',
    near_account: nearAccountId,
    evm_address: evmAddress,
    network,
    story_chain: storyChainId,
    ipfs: params.pinata_jwt ? 'pinata' : 'free-gateway',
    next_steps: [
      !params.near_private_key ? `Create NEAR account: near account create-account sponsor-by-faucet-service ${nearAccountId} ...` : null,
      `Get testnet IP tokens from faucet for Story Protocol transactions`,
    ].filter(Boolean),
  };
}
