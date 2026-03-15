/**
 * License tool — mint license tokens.
 */

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';

export const licenseTool = {
  async mint(config: Config, params: { ip_id: string; license_terms_id: string; amount: number }) {
    try {
      const { StoryClient } = await import('@story-protocol/core-sdk');
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

      const result = await client.license.mintLicenseTokens({
        licenseTermsId: BigInt(params.license_terms_id),
        licensorIpId: params.ip_id as Address,
        amount: params.amount,
        receiver: account.address as Address,
      });

      return {
        success: true,
        licenseTokenIds: result.licenseTokenIds?.map(String),
        txHash: result.txHash,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
