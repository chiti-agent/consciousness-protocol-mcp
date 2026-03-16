/**
 * Verify provenance + get IP details for agents.
 * Fetches IPFS metadata, on-chain license terms, NEAR state.
 * Returns everything an agent needs to decide: buy, remix, or skip.
 */

import type { Config } from '../config/store.js';
import { createHash } from 'node:crypto';

export const verifyProvenanceTool = {
  async verify(config: Config, ipId: string) {
    try {
      const { loadKey } = await import('../config/store.js');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { createPublicClient, http, formatEther } = await import('viem');
      const { nearTools } = await import('./near.js');

      type Address = `0x${string}`;
      const evmClient = createPublicClient({ transport: http(config.story.rpcUrl) });

      // Step 1: Get IP metadata URI from on-chain (IP Asset Registry)
      // Read metadataURI from the IP Account contract
      let ipfsMetadata: any = null;
      let metadataUri: string | null = null;

      // Try to get metadata from registrations log first
      const { existsSync, readFileSync } = await import('node:fs');
      const { REGISTRATIONS_FILE } = await import('../config/store.js');

      if (existsSync(REGISTRATIONS_FILE)) {
        const regs = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
        const match = regs.find((r: any) => r.ipId?.toLowerCase() === ipId.toLowerCase());
        if (match?.ipfsUri) {
          metadataUri = match.ipfsUri;
        }
      }

      // Fetch metadata from IPFS
      if (metadataUri) {
        const gateway = metadataUri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
        try {
          const res = await fetch(gateway, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            ipfsMetadata = await res.json();
          }
        } catch { /* IPFS fetch failed, continue without */ }
      }

      // Step 2: Get on-chain license terms
      let licenseInfo: any = null;
      const pilAbi = [{
        name: 'getLicenseTerms',
        type: 'function' as const,
        inputs: [{ name: 'selectedLicenseTermsId', type: 'uint256' as const }],
        outputs: [{ name: '', type: 'tuple' as const, components: [
          { name: 'transferable', type: 'bool' as const },
          { name: 'royaltyPolicy', type: 'address' as const },
          { name: 'defaultMintingFee', type: 'uint256' as const },
          { name: 'expiration', type: 'uint256' as const },
          { name: 'commercialUse', type: 'bool' as const },
          { name: 'commercialAttribution', type: 'bool' as const },
          { name: 'commercializerChecker', type: 'address' as const },
          { name: 'commercializerCheckerData', type: 'bytes' as const },
          { name: 'commercialRevShare', type: 'uint32' as const },
          { name: 'commercialRevCeiling', type: 'uint256' as const },
          { name: 'derivativesAllowed', type: 'bool' as const },
          { name: 'derivativesAttribution', type: 'bool' as const },
          { name: 'derivativesApproval', type: 'bool' as const },
          { name: 'derivativesReciprocal', type: 'bool' as const },
          { name: 'derivativeRevCeiling', type: 'uint256' as const },
          { name: 'currency', type: 'address' as const },
          { name: 'uri', type: 'string' as const },
        ]}],
        stateMutability: 'view' as const,
      }];

      // Try to find license terms ID from metadata or registrations
      let licenseTermsId: string | null = null;
      if (existsSync(REGISTRATIONS_FILE)) {
        const regs = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
        const match = regs.find((r: any) => r.ipId?.toLowerCase() === ipId.toLowerCase());
        if (match?.licenseTermsIds?.[0]) {
          licenseTermsId = match.licenseTermsIds[0];
        }
      }

      if (licenseTermsId) {
        try {
          const PIL = '0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316' as Address;
          const terms = await evmClient.readContract({
            address: PIL,
            abi: pilAbi,
            functionName: 'getLicenseTerms',
            args: [BigInt(licenseTermsId)],
          }) as any;

          licenseInfo = {
            termsId: licenseTermsId,
            commercialUse: terms.commercialUse,
            commercialRevShare: `${Number(terms.commercialRevShare) / 1_000_000}%`,
            mintingFee: formatEther(terms.defaultMintingFee) + ' IP',
            derivativesAllowed: terms.derivativesAllowed,
            derivativesReciprocal: terms.derivativesReciprocal,
            transferable: terms.transferable,
          };
        } catch { /* license query failed */ }
      }

      // Step 3: NEAR verification
      let nearInfo: any = null;
      const nearAccount = ipfsMetadata?.attributes?.find((a: any) => a.key === 'near_account')?.value;
      if (nearAccount) {
        const nearResult = await nearTools.getAgent(config, nearAccount);
        if (nearResult.success) {
          nearInfo = nearResult.agent;
        }
      }

      // Step 4: Extract provenance from metadata
      const chainSeq = ipfsMetadata?.attributes?.find((a: any) => a.key === 'chain_sequence')?.value;
      const chainHash = ipfsMetadata?.attributes?.find((a: any) => a.key === 'chain_hash')?.value;
      const contentHash = ipfsMetadata?.attributes?.find((a: any) => a.key === 'content_hash')?.value;
      const aiGenerated = ipfsMetadata?.attributes?.find((a: any) => a.key === 'ai_generated')?.value;
      const mediaUrl = ipfsMetadata?.mediaUrl;

      // Build response for agent
      const result: any = {
        success: true,
        ipId,
        explorer: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}explorer.story.foundation/ipa/${ipId}`,

        // What is this work?
        work: ipfsMetadata ? {
          title: ipfsMetadata.title,
          description: ipfsMetadata.description,
          type: ipfsMetadata.ipType,
          creator: ipfsMetadata.creators?.[0]?.name,
          creatorAddress: ipfsMetadata.creators?.[0]?.address,
          aiGenerated: aiGenerated === 'true',
          contentUrl: mediaUrl ? mediaUrl.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/') : null,
          contentHash,
        } : { note: 'Metadata not available (not in local registrations)' },

        // How much does it cost?
        license: licenseInfo || { note: 'License terms not found in local registrations' },

        // How to buy/use
        actions: {
          mintLicense: licenseInfo ? {
            tool: 'mint_license',
            params: { ip_id: ipId, license_terms_id: licenseTermsId },
            cost: licenseInfo.mintingFee,
            description: `Mint a license token to use this work. Cost: ${licenseInfo.mintingFee}`,
          } : null,
          createDerivative: licenseInfo?.derivativesAllowed ? {
            tool: 'register_derivative',
            params: { parent_ip_id: ipId, parent_license_terms_id: licenseTermsId },
            cost: `${licenseInfo.mintingFee} + gas. ${licenseInfo.commercialRevShare} of your revenue goes to creator.`,
            description: `Create a derivative work. Revenue share: ${licenseInfo.commercialRevShare}`,
          } : null,
          payRoyalty: {
            tool: 'pay_royalty',
            params: { receiver_ip_id: ipId },
            description: 'Send a royalty payment to the creator',
          },
        },

        // Provenance verification
        provenance: {
          chainSequence: chainSeq || null,
          chainHash: chainHash || null,
          nearAccount: nearAccount || null,
          nearAgent: nearInfo,
          verified: !!(chainSeq && nearInfo),
        },
      };

      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
