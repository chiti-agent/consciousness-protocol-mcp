/**
 * NEAR tools — publish state hashes, query agent info.
 */

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';

// Lazy-load near-api-js to avoid startup cost
async function getNearProvider(config: Config) {
  const { JsonRpcProvider } = await import('near-api-js');
  const rpcUrl = config.network === 'testnet'
    ? 'https://rpc.testnet.near.org'
    : 'https://rpc.mainnet.near.org';
  return new JsonRpcProvider({ url: rpcUrl });
}

export const nearTools = {
  async publishState(config: Config, params: { sequence: number; hash: string; prev_hash: string }) {
    try {
      const { Account, JsonRpcProvider } = await import('near-api-js');
      const rpcUrl = config.network === 'testnet'
        ? 'https://rpc.testnet.near.org'
        : 'https://rpc.mainnet.near.org';
      const provider = new JsonRpcProvider({ url: rpcUrl });
      const privateKey = loadKey('near');

      const account = new Account(config.near.accountId, provider, privateKey as any);
      const result = await account.callFunction({
        contractId: config.near.registryContract,
        methodName: 'publish_state',
        args: {
          sequence: params.sequence,
          hash: params.hash,
          prev_hash: params.prev_hash,
          timestamp: Date.now() * 1_000_000, // nanoseconds
        },
        gas: BigInt(30_000_000_000_000), // 30 TGas
        deposit: BigInt(0),
      });

      return {
        success: true,
        sequence: params.sequence,
        hash: params.hash.slice(0, 16) + '...',
        near_tx: result,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async getAgent(config: Config, agentId: string) {
    try {
      const { JsonRpcProvider } = await import('near-api-js');
      const rpcUrl = config.network === 'testnet'
        ? 'https://rpc.testnet.near.org'
        : 'https://rpc.mainnet.near.org';
      const provider = new JsonRpcProvider({ url: rpcUrl });

      const result = await provider.callFunction({
        contractId: config.near.registryContract,
        method: 'get_agent',
        args: { agent_id: agentId },
      });

      return {
        success: true,
        agent: result,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
