/**
 * Royalty tools — pay royalties and claim revenue.
 */

import type { Config } from '../config/store.js';
import { loadKey, REGISTRATIONS_FILE } from '../config/store.js';
import { readFileSync, existsSync } from 'node:fs';

export const royaltyTool = {
  async pay(config: Config, params: { receiver_ip_id: string; amount: string }) {
    try {
      const { StoryClient, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http, parseEther, zeroAddress } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: http(config.story.rpcUrl),
        chainId: config.story.chainId,
      });

      const result = await Promise.race([
        client.royalty.payRoyaltyOnBehalf({
          receiverIpId: params.receiver_ip_id as Address,
          payerIpId: zeroAddress,
          token: WIP_TOKEN_ADDRESS,
          amount: parseEther(params.amount),
          // Note: SDK handles IP→WIP wrapping internally
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      return {
        success: true,
        txHash: result.txHash,
        amount: params.amount,
        receiver: params.receiver_ip_id,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async claim(config: Config, params: { ip_id?: string }) {
    try {
      const { StoryClient, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: http(config.story.rpcUrl),
        chainId: config.story.chainId,
      });

      // Get IP IDs to claim from
      let ipIds: string[] = [];
      if (params.ip_id) {
        ipIds = [params.ip_id];
      } else if (existsSync(REGISTRATIONS_FILE)) {
        const registrations = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
        ipIds = registrations
          .filter((r: any) => r.success && r.ipId)
          .map((r: any) => r.ipId);
      }

      if (ipIds.length === 0) {
        return { success: true, claimed: [], total: '0', message: 'No registered IPs found' };
      }

      const claimed: Array<{ ipId: string; amount: string }> = [];
      const errors: Array<{ ipId: string; error: string }> = [];
      for (const ipId of ipIds) {
        try {
          const result = await Promise.race([
            client.royalty.claimAllRevenue({
              ancestorIpId: ipId as Address,
              // claimer = ipId: the IP account holds royalty tokens by default after registration
              claimer: ipId as Address,
              currencyTokens: [WIP_TOKEN_ADDRESS],
              // Empty arrays: claims direct payments only. To claim derivative revenue,
              // childIpIds and royaltyPolicies must be populated with known derivatives.
              childIpIds: [],
              royaltyPolicies: [],
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
          ]);

          if (result.claimedTokens && result.claimedTokens.length > 0) {
            for (const ct of result.claimedTokens) {
              claimed.push({
                ipId,
                amount: ct.amount?.toString() ?? '0',
              });
            }
          }
        } catch (err: any) {
          const msg = err.message || String(err);
          // Skip expected "no vault" / "no revenue" errors, but log unexpected ones
          if (!msg.includes('vault') && !msg.includes('revenue') && !msg.includes('IpRoyaltyVault__NoClaimableTokens')) {
            errors.push({ ipId, error: msg });
          }
        }
      }

      return {
        success: true,
        claimed,
        total_ips_checked: ipIds.length,
        ...(errors.length > 0 && { errors }),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
