/**
 * License configuration tools:
 * - attachLicenseTerms: attach a NEW PIL terms set to a root IP (protocol
 *   forbids it for derivatives: LicensingModule__DerivativesCannotAddLicenseTerms).
 * - setLicensingConfig: per-IP pricing override (mintingFee / commercialRevShare /
 *   disabled) — the only way to change the price of an existing node, since
 *   attached license terms are immutable.
 */

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { cappedHttp } from '../config/fee-cap.js';
import { applyPolicyChoice, type RoyaltyPolicyChoice } from './register-work.js';
import { postVolemEvent } from '../volem-events.js';

const LICENSE_REGISTRY = '0x529a750E02d8E2f15649c13D69a465286a780e24' as const;

const PARENT_COUNT_ABI = [
  {
    inputs: [{ name: 'childIpId', type: 'address' }],
    name: 'getParentIpCount',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

async function getWalletClient(config: Config) {
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
  return { client, account };
}

async function isDerivative(config: Config, ipId: `0x${string}`): Promise<boolean> {
  const { createPublicClient, http } = await import('viem');
  const publicClient = createPublicClient({ transport: http(config.story.rpcUrl) });
  const count = await publicClient.readContract({
    address: LICENSE_REGISTRY,
    abi: PARENT_COUNT_ABI,
    functionName: 'getParentIpCount',
    args: [ipId],
  }) as bigint;
  return count > BigInt(0);
}

export const licenseConfigTool = {
  async attachLicenseTerms(config: Config, params: {
    ip_id: string;
    license: 'commercial-exclusive' | 'commercial-remix';
    minting_fee?: string;
    revenue_share?: number;
    royalty_policy?: RoyaltyPolicyChoice;
    reciprocal?: boolean;
  }) {
    try {
      type Address = `0x${string}`;
      const ipId = params.ip_id as Address;

      // Friendly guard: the protocol hard-rejects new terms on derivatives
      // (their terms are locked to the parent's by reciprocity).
      if (await isDerivative(config, ipId)) {
        return {
          success: false,
          error: 'This IP is a derivative — Story Protocol forbids attaching new license terms to derivatives (LicensingModule__DerivativesCannotAddLicenseTerms). Use set_licensing_config to change its pricing instead.',
        };
      }

      const { PILFlavor, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { parseEther } = await import('viem');
      const { client } = await getWalletClient(config);

      const mintingFee = params.minting_fee && params.minting_fee !== '0'
        ? parseEther(params.minting_fee)
        : 0n;

      const terms = applyPolicyChoice(
        params.license === 'commercial-exclusive'
          ? PILFlavor.commercialUse({ defaultMintingFee: mintingFee, currency: WIP_TOKEN_ADDRESS })
          : PILFlavor.commercialRemix({
              commercialRevShare: params.revenue_share ?? 5,
              defaultMintingFee: mintingFee,
              currency: WIP_TOKEN_ADDRESS,
            }),
        params.royalty_policy,
        params.reciprocal,
      );

      const result = await Promise.race([
        client.license.registerPilTermsAndAttach({
          ipId,
          licenseTermsData: [{ terms }],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      const licenseTermsIds = result.licenseTermsIds?.map(String);

      await postVolemEvent(config, {
        ip_id: params.ip_id,
        event_type: 'LICENSE_ADDED',
        license_terms_id: licenseTermsIds?.[0],
        tx_hash: result.txHash,
        metadata: {
          license: params.license,
          mintingFee: mintingFee.toString(),
          revenueShare: params.revenue_share ?? (params.license === 'commercial-remix' ? 5 : 0),
          royaltyPolicy: params.royalty_policy ?? 'LAP',
        },
      });

      return {
        success: true,
        licenseTermsIds,
        txHash: result.txHash,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async setLicensingConfig(config: Config, params: {
    ip_id: string;
    license_terms_id: string;
    minting_fee?: string;
    revenue_share?: number;
    disabled?: boolean;
  }) {
    try {
      if (!/^\d+$/.test(params.license_terms_id)) {
        return { success: false, error: `Invalid license terms ID "${params.license_terms_id}". Must be a numeric string.` };
      }
      if (params.minting_fee === undefined && params.revenue_share === undefined && params.disabled === undefined) {
        return { success: false, error: 'Nothing to change: provide minting_fee, revenue_share and/or disabled.' };
      }

      type Address = `0x${string}`;
      const ipId = params.ip_id as Address;
      const { parseEther, formatEther, zeroAddress } = await import('viem');
      const { client } = await getWalletClient(config);

      // Merge with the current on-chain config so a partial update does not
      // silently reset the other fields to zero.
      const current = await client.license.getLicensingConfig({
        ipId,
        licenseTermsId: BigInt(params.license_terms_id),
      });

      const currentRevSharePercent = Number(current.commercialRevShare) / 1_000_000;
      const mintingFee = params.minting_fee !== undefined
        ? parseEther(params.minting_fee)
        : current.mintingFee;
      // SDK expects percent (0-100). Contract semantics: a zero
      // commercialRevShare in the config is IGNORED (terms value applies);
      // a non-zero value must be >= the terms value (upward-only override).
      // The config mintingFee must be >= the terms fee or the tx reverts.
      const commercialRevShare = params.revenue_share ?? currentRevSharePercent;
      const disabled = params.disabled ?? current.disabled;

      const result = await Promise.race([
        client.license.setLicensingConfig({
          ipId,
          licenseTermsId: BigInt(params.license_terms_id),
          licensingConfig: {
            isSet: true,
            mintingFee,
            licensingHook: current.licensingHook ?? zeroAddress,
            hookData: (current.hookData as `0x${string}`) ?? '0x',
            commercialRevShare,
            disabled,
            expectMinimumGroupRewardShare: 0,
            expectGroupRewardPool: zeroAddress,
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Story Protocol call timed out after 60s')), 60_000)),
      ]);

      return {
        success: true,
        txHash: result.txHash,
        effective: {
          mintingFee: formatEther(mintingFee),
          revenueSharePercent: commercialRevShare === 0
            ? 'inherited from license terms (config 0 is ignored by the protocol)'
            : commercialRevShare,
          disabled,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
