/**
 * Register work + derivative on Story Protocol.
 */

import { createHash } from 'node:crypto';
import type { Config } from '../config/store.js';
import { loadKey, REGISTRATIONS_FILE } from '../config/store.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

async function getStoryClient(config: Config) {
  const { StoryClient } = await import('@story-protocol/core-sdk');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { http } = await import('viem');

  const pk = loadKey('evm');
  const account = privateKeyToAccount(pk as `0x${string}`);

  return StoryClient.newClient({
    account,
    transport: http(config.story.rpcUrl),
    chainId: config.story.chainId,
  });
}

async function uploadToIPFS(config: Config, data: object): Promise<string> {
  if (config.ipfs.pinataJwt) {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ipfs.pinataJwt}`,
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataMetadata: { name: `cp-${Date.now()}` },
      }),
    });
    if (!res.ok) throw new Error(`Pinata: ${res.status}`);
    const result = await res.json() as { IpfsHash: string };
    return `ipfs://${result.IpfsHash}`;
  }
  // Fallback: encode as data URI (works for testnet, not production)
  const json = JSON.stringify(data);
  const hash = createHash('sha256').update(json).digest('hex');
  return `data:application/json;hash=${hash}`;
}

function logRegistration(entry: object) {
  let registrations: object[] = [];
  if (existsSync(REGISTRATIONS_FILE)) {
    registrations = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
  }
  registrations.push({ ...entry, registeredAt: new Date().toISOString() });
  writeFileSync(REGISTRATIONS_FILE, JSON.stringify(registrations, null, 2));
}

export const registerWorkTool = {
  async register(config: Config, params: {
    title: string;
    content: string;
    type: string;
    license: string;
    chain_sequence?: number;
    chain_hash?: string;
  }) {
    try {
      const client = await getStoryClient(config);
      const { PILFlavor, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { zeroAddress } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const contentHash = createHash('sha256').update(params.content).digest('hex');

      // Build metadata with provenance
      const attributes: Array<{ key: string; value: string }> = [
        { key: 'content_hash', value: contentHash },
        { key: 'ai_generated', value: 'true' },
        { key: 'near_account', value: config.near.accountId },
      ];
      if (params.chain_sequence !== undefined) {
        attributes.push({ key: 'chain_sequence', value: String(params.chain_sequence) });
      }
      if (params.chain_hash) {
        attributes.push({ key: 'chain_hash', value: params.chain_hash });
      }

      const ipMetadata = client.ipAsset.generateIpMetadata({
        title: params.title,
        description: `AI-generated ${params.type} with blockchain provenance`,
        ipType: `text/${params.type}`,
        creators: [{
          name: config.near.accountId,
          address: account.address as Address,
          contributionPercent: 100,
        }],
        attributes,
      });

      // Upload to IPFS
      const ipMetadataURI = await uploadToIPFS(config, ipMetadata);
      const ipMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(ipMetadata)).digest('hex')) as `0x${string}`;

      const nftMetadata = { name: params.title, description: `AI-generated ${params.type}` };
      const nftMetadataURI = await uploadToIPFS(config, nftMetadata);
      const nftMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(nftMetadata)).digest('hex')) as `0x${string}`;

      // Create SPG collection if needed
      let spgContract = config.story.spgNftContract;
      if (!spgContract) {
        const collection = await client.nftClient.createNFTCollection({
          name: `${config.near.accountId} Works`,
          symbol: 'CPIP',
          isPublicMinting: false,
          mintOpen: true,
          mintFeeRecipient: zeroAddress,
          contractURI: '',
        });
        spgContract = collection.spgNftContract!;
        // Save for reuse
        config.story.spgNftContract = spgContract;
        const { saveConfig } = await import('../config/store.js');
        saveConfig(config);
      }

      // Register IP
      const licenseTerms = params.license === 'free'
        ? PILFlavor.nonCommercialSocialRemixing()
        : PILFlavor.commercialRemix({
            commercialRevShare: 5,
            defaultMintingFee: 0n,
            currency: WIP_TOKEN_ADDRESS,
          });

      const response = await client.ipAsset.registerIpAsset({
        nft: { type: 'mint', spgNftContract: spgContract as Address },
        licenseTermsData: [{ terms: licenseTerms }],
        ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
      });

      // Mint license token to create vault
      if (response.licenseTermsIds?.[0]) {
        await client.license.mintLicenseTokens({
          licenseTermsId: response.licenseTermsIds[0],
          licensorIpId: response.ipId! as Address,
          amount: 1,
          receiver: account.address as Address,
        });
      }

      const result = {
        success: true,
        ipId: response.ipId,
        txHash: response.txHash,
        tokenId: String(response.tokenId),
        licenseTermsIds: response.licenseTermsIds?.map(String),
        ipfsUri: ipMetadataURI,
        contentHash,
        explorerUrl: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}storyscan.io/address/${response.ipId}`,
      };

      logRegistration({ ...result, title: params.title, type: params.type });
      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },

  async registerDerivative(config: Config, params: {
    title: string;
    content: string;
    type: string;
    parent_ip_id: string;
    parent_license_terms_id: string;
    license_token_id?: string;
  }) {
    try {
      const client = await getStoryClient(config);
      const { PILFlavor, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { zeroAddress } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);
      const contentHash = createHash('sha256').update(params.content).digest('hex');

      const ipMetadata = client.ipAsset.generateIpMetadata({
        title: params.title,
        description: `Derivative work`,
        ipType: `text/${params.type}`,
        creators: [{
          name: config.near.accountId,
          address: account.address as Address,
          contributionPercent: 100,
        }],
        attributes: [
          { key: 'content_hash', value: contentHash },
          { key: 'parent_ip', value: params.parent_ip_id },
          { key: 'ai_generated', value: 'true' },
        ],
      });

      const ipMetadataURI = await uploadToIPFS(config, ipMetadata);
      const ipMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(ipMetadata)).digest('hex')) as `0x${string}`;
      const nftMetadata = { name: params.title, description: 'Derivative work' };
      const nftMetadataURI = await uploadToIPFS(config, nftMetadata);
      const nftMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(nftMetadata)).digest('hex')) as `0x${string}`;

      let spgContract = config.story.spgNftContract;
      if (!spgContract) {
        const collection = await client.nftClient.createNFTCollection({
          name: `${config.near.accountId} Works`,
          symbol: 'CPIP',
          isPublicMinting: false,
          mintOpen: true,
          mintFeeRecipient: zeroAddress,
          contractURI: '',
        });
        spgContract = collection.spgNftContract!;
        config.story.spgNftContract = spgContract;
        const { saveConfig } = await import('../config/store.js');
        saveConfig(config);
      }

      const response = await client.ipAsset.registerIpAsset({
        nft: { type: 'mint', spgNftContract: spgContract as Address },
        licenseTermsData: [{
          terms: PILFlavor.commercialRemix({
            commercialRevShare: 5,
            defaultMintingFee: 0n,
            currency: WIP_TOKEN_ADDRESS,
          }),
        }],
        derivData: {
          parentIpIds: [params.parent_ip_id as Address],
          licenseTermsIds: [BigInt(params.parent_license_terms_id)],
          maxMintingFee: 0n,
          maxRts: 100_000_000n,
          maxRevenueShare: 100,
        },
        ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
      });

      const result = {
        success: true,
        ipId: response.ipId,
        txHash: response.txHash,
        parentIpId: params.parent_ip_id,
        explorerUrl: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}storyscan.io/address/${response.ipId}`,
      };

      logRegistration({ ...result, title: params.title, type: params.type, derivative: true });
      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
