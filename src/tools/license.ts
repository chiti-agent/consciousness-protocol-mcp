/**
 * License tool — mint license tokens.
 */

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { cappedHttp } from '../config/fee-cap.js';
import { postVolemEvent } from '../volem-events.js';

export const licenseTool = {
  async mint(config: Config, params: { ip_id: string; license_terms_id: string; amount: number }) {
    try {
      if (!/^\d+$/.test(params.license_terms_id)) {
        return { success: false, error: `Invalid license terms ID "${params.license_terms_id}". Must be a numeric string.` };
      }

      const { StoryClient } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: cappedHttp(http, config.story.rpcUrl),
        chainId: config.story.chainId,
      });

      const result = await Promise.race([
        client.license.mintLicenseTokens({
          licenseTermsId: BigInt(params.license_terms_id),
          licensorIpId: params.ip_id as Address,
          amount: params.amount,
          receiver: account.address as Address,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      await postVolemEvent(config, {
        ip_id: params.ip_id,
        event_type: 'LICENSE_MINTED',
        license_terms_id: params.license_terms_id,
        token_id: result.licenseTokenIds?.[0] !== undefined ? String(result.licenseTokenIds[0]) : undefined,
        tx_hash: result.txHash,
        metadata: { amount: params.amount, receiver: account.address },
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
