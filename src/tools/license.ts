/**
 * License tool — mint license tokens.
 */

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { cappedHttp } from '../config/fee-cap.js';
import { postVolemEvent } from '../volem-events.js';
import { formatEther, parseEther } from 'viem';

type Address = `0x${string}`;

export type MintLicenseParams = {
  ip_id: string;
  license_terms_id: string;
  amount: number;
  receiver?: string;
  max_minting_fee?: string;
};

type MintFeePredictor = {
  predictMintingLicenseFee(request: {
    licensorIpId: Address;
    licenseTermsId: bigint;
    amount: number;
    receiver: Address;
  }): Promise<{ currencyToken: Address; tokenAmount: bigint }>;
};

const MAX_MINTING_FEE_PATTERN = /^\d+(?:\.\d{1,18})?$/;

/** Build a mint request whose zero fee cannot become the protocol's unlimited sentinel. */
export async function prepareMintLicenseRequest(
  license: MintFeePredictor,
  params: MintLicenseParams,
  defaultReceiver: Address,
) {
  const receiver = params.receiver ?? defaultReceiver;
  if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
    throw new Error(`Invalid receiver "${receiver}". Must be a valid Ethereum address.`);
  }

  const quoteRequest = {
    licensorIpId: params.ip_id as Address,
    licenseTermsId: BigInt(params.license_terms_id),
    amount: params.amount,
    receiver: receiver as Address,
  };
  const quote = await license.predictMintingLicenseFee(quoteRequest);

  let requestedMaxMintingFee = quote.tokenAmount;
  if (params.max_minting_fee !== undefined) {
    if (!MAX_MINTING_FEE_PATTERN.test(params.max_minting_fee)) {
      throw new Error('Invalid max_minting_fee. Use a non-negative WIP amount with at most 18 decimal places.');
    }
    requestedMaxMintingFee = parseEther(params.max_minting_fee);
    if (quote.tokenAmount > requestedMaxMintingFee) {
      throw new Error(
        `Current total minting fee ${formatEther(quote.tokenAmount)} exceeds max_minting_fee ${params.max_minting_fee}; mint aborted before transaction.`,
      );
    }
  }

  return {
    request: {
      ...quoteRequest,
      // Story treats 0 as unlimited, so 1 wei is the strictest usable free-mint guard.
      maxMintingFee: requestedMaxMintingFee === 0n ? 1n : requestedMaxMintingFee,
      maxRevenueShare: 100,
    },
    quote,
  };
}

export const licenseTool = {
  async mint(config: Config, params: MintLicenseParams) {
    try {
      if (!/^\d+$/.test(params.license_terms_id)) {
        return { success: false, error: `Invalid license terms ID "${params.license_terms_id}". Must be a numeric string.` };
      }

      const { StoryClient } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { http } = await import('viem');

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const client = StoryClient.newClient({
        account,
        transport: cappedHttp(http, config.story.rpcUrl),
        chainId: config.story.chainId,
      });
      const prepared = await prepareMintLicenseRequest(client.license, params, account.address);

      const result = await Promise.race([
        client.license.mintLicenseTokens(prepared.request),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      await postVolemEvent(config, {
        ip_id: params.ip_id,
        event_type: 'LICENSE_MINTED',
        license_terms_id: params.license_terms_id,
        token_id: result.licenseTokenIds?.[0] !== undefined ? String(result.licenseTokenIds[0]) : undefined,
        tx_hash: result.txHash,
        metadata: {
          amount: params.amount,
          receiver: prepared.request.receiver,
          quotedMintingFee: prepared.quote.tokenAmount.toString(),
          mintingFeeToken: prepared.quote.currencyToken,
        },
      });

      return {
        success: true,
        licenseTokenIds: result.licenseTokenIds?.map(String),
        txHash: result.txHash,
        receiver: prepared.request.receiver,
        quotedMintingFee: formatEther(prepared.quote.tokenAmount),
        mintingFeeToken: prepared.quote.currencyToken,
        maxMintingFee: formatEther(prepared.request.maxMintingFee),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
