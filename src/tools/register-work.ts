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
      signal: AbortSignal.timeout(30_000), // 30s timeout
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

async function uploadFileToIPFS(config: Config, buffer: Buffer, filename: string): Promise<string> {
  if (config.ipfs.pinataJwt) {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
    formData.append('pinataMetadata', JSON.stringify({ name: `cp-file-${Date.now()}` }));

    const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.ipfs.pinataJwt}` },
      body: formData,
      signal: AbortSignal.timeout(60_000), // 60s timeout for file upload
    });
    if (!res.ok) throw new Error(`Pinata file upload: ${res.status}`);
    const result = await res.json() as { IpfsHash: string };
    return `ipfs://${result.IpfsHash}`;
  }
  const hash = createHash('sha256').update(buffer).digest('hex');
  return `data:application/octet-stream;hash=${hash}`;
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
    content?: string;
    file_path?: string;
    media_type?: string;
    type: string;
    license: string;
    revenue_share?: number;
    minting_fee?: string;
    chain_sequence?: number;
    chain_hash?: string;
  }) {
    try {
      if (!params.content && !params.file_path) {
        return { success: false, error: 'Either content or file_path is required' };
      }

      const client = await getStoryClient(config);
      const { PILFlavor, WIP_TOKEN_ADDRESS } = await import('@story-protocol/core-sdk');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { zeroAddress } = await import('viem');
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = privateKeyToAccount(pk as `0x${string}`);

      // Handle text content or file
      let contentHash: string;
      let ipType: string;
      let mediaUrl: string | undefined;

      if (params.file_path) {
        const { readFileSync } = await import('node:fs');
        const { extname } = await import('node:path');
        const fileBuffer = readFileSync(params.file_path);
        contentHash = createHash('sha256').update(fileBuffer).digest('hex');

        // Detect MIME type from extension
        const ext = extname(params.file_path).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
          '.mp4': 'video/mp4', '.webm': 'video/webm',
          '.ts': 'text/typescript', '.js': 'text/javascript', '.py': 'text/x-python',
          '.rs': 'text/x-rust', '.go': 'text/x-go', '.sol': 'text/x-solidity',
          '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
        };
        ipType = params.media_type || mimeMap[ext] || 'application/octet-stream';

        // Upload file to IPFS
        mediaUrl = await uploadFileToIPFS(config, fileBuffer, params.title + ext);
      } else {
        contentHash = createHash('sha256').update(params.content!).digest('hex');
        ipType = params.media_type || `text/${params.type}`;
      }

      // Build metadata with provenance
      const revShare = params.revenue_share ?? 5;
      const licenseType = params.license || 'commercial-remix';
      const attributes: Array<{ key: string; value: string }> = [
        { key: 'content_hash', value: contentHash },
        { key: 'ai_generated', value: 'true' },
        { key: 'near_account', value: config.near.accountId },
        { key: 'license', value: licenseType },
        { key: 'commercial_use', value: licenseType !== 'free' ? 'true' : 'false' },
        { key: 'derivatives_allowed', value: 'true' },
        { key: 'revenue_share_percent', value: String(revShare) },
        { key: 'minting_fee', value: params.minting_fee || '0' },
      ];
      if (params.chain_sequence !== undefined) {
        attributes.push({ key: 'chain_sequence', value: String(params.chain_sequence) });
      }
      if (params.chain_hash) {
        attributes.push({ key: 'chain_hash', value: params.chain_hash });
      }

      const metadataInput: Record<string, unknown> = {
        title: params.title,
        description: `AI-generated ${params.type} with blockchain provenance`,
        ipType,
        creators: [{
          name: config.near.accountId,
          address: account.address as Address,
          contributionPercent: 100,
        }],
        attributes,
      };
      // For text content: upload the text itself to IPFS as media
      if (!mediaUrl && params.content) {
        const textBuffer = Buffer.from(params.content, 'utf-8');
        mediaUrl = await uploadFileToIPFS(config, textBuffer, `${params.title}.txt`);
        metadataInput.mediaUrl = mediaUrl;
        metadataInput.mediaHash = '0x' + contentHash;
        metadataInput.mediaType = 'text/plain';
      }

      // Add media fields for file-based content
      if (mediaUrl && !metadataInput.mediaUrl) {
        metadataInput.mediaUrl = mediaUrl;
        metadataInput.mediaHash = '0x' + contentHash;
        metadataInput.mediaType = ipType;
      }

      const ipMetadata = client.ipAsset.generateIpMetadata(metadataInput as any);

      // Upload to IPFS
      const ipMetadataURI = await uploadToIPFS(config, ipMetadata);
      const ipMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(ipMetadata)).digest('hex')) as `0x${string}`;

      const nftMetadata = {
        name: params.title,
        description: `AI-generated ${params.type} with blockchain provenance`,
        external_url: mediaUrl || '',
      };
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
      const { parseEther: toWei } = await import('viem');
      const mintingFee = params.minting_fee && params.minting_fee !== '0'
        ? toWei(params.minting_fee)
        : 0n;

      const licenseTerms = params.license === 'free'
        ? PILFlavor.nonCommercialSocialRemixing()
        : PILFlavor.commercialRemix({
            commercialRevShare: params.revenue_share ?? 5,
            defaultMintingFee: mintingFee,
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
        explorerUrl: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}explorer.story.foundation/ipa/${response.ipId}`,
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
        explorerUrl: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}explorer.story.foundation/ipa/${response.ipId}`,
      };

      logRegistration({ ...result, title: params.title, type: params.type, derivative: true });
      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
