/**
 * Register work + derivative on Story Protocol.
 */

import { createHash } from 'node:crypto';
import type { Config } from '../config/store.js';
import { loadKey, REGISTRATIONS_FILE } from '../config/store.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Lazy-loaded modules — cached after first import
let _StoryClient: typeof import('@story-protocol/core-sdk').StoryClient;
let _PILFlavor: typeof import('@story-protocol/core-sdk').PILFlavor;
let _WIP_TOKEN_ADDRESS: typeof import('@story-protocol/core-sdk').WIP_TOKEN_ADDRESS;
let _privateKeyToAccount: typeof import('viem/accounts').privateKeyToAccount;
let _http: typeof import('viem').http;
let _zeroAddress: typeof import('viem').zeroAddress;
let _parseEther: typeof import('viem').parseEther;

async function ensureImports() {
  if (_StoryClient) return;
  const sdk = await import('@story-protocol/core-sdk');
  _StoryClient = sdk.StoryClient;
  _PILFlavor = sdk.PILFlavor;
  _WIP_TOKEN_ADDRESS = sdk.WIP_TOKEN_ADDRESS;
  const accounts = await import('viem/accounts');
  _privateKeyToAccount = accounts.privateKeyToAccount;
  const viem = await import('viem');
  _http = viem.http;
  _zeroAddress = viem.zeroAddress;
  _parseEther = viem.parseEther;
}

async function getStoryClient(config: Config) {
  await ensureImports();

  const pk = loadKey('evm');
  const account = _privateKeyToAccount(pk as `0x${string}`);

  return _StoryClient.newClient({
    account,
    transport: _http(config.story.rpcUrl),
    chainId: config.story.chainId,
  });
}

/** Get all available Pinata JWT keys (single key + rotation pool) */
function getPinataKeys(config: Config): string[] {
  const keys: string[] = [];
  if (config.ipfs.pinataKeys?.length) keys.push(...config.ipfs.pinataKeys);
  else if (config.ipfs.pinataJwt) keys.push(config.ipfs.pinataJwt);
  return keys;
}

/** Try Pinata upload with key rotation. Returns ipfs:// URI or null if all keys exhausted. */
async function tryPinataJSON(keys: string[], data: object): Promise<string | null> {
  for (const jwt of keys) {
    try {
      const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          pinataContent: data,
          pinataMetadata: { name: `cp-${Date.now()}` },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const result = await res.json() as { IpfsHash: string };
        return `ipfs://${result.IpfsHash}`;
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        console.error(`Pinata key exhausted (${res.status}), trying next...`);
        continue;
      }
      // Other HTTP errors (5xx, etc.) — rotate to next key
      console.error(`Pinata HTTP error (${res.status}), trying next key...`);
      continue;
    } catch (err: any) {
      // Non-HTTP errors (network, timeout, etc.) — rotate to next key
      console.error(`Pinata upload error: ${err.message}, trying next key...`);
      continue;
    }
  }
  return null;
}

/** Try Pinata file upload with key rotation. */
async function tryPinataFile(keys: string[], buffer: Buffer, filename: string): Promise<string | null> {
  for (const jwt of keys) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
      formData.append('pinataMetadata', JSON.stringify({ name: `cp-file-${Date.now()}` }));
      const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const result = await res.json() as { IpfsHash: string };
        return `ipfs://${result.IpfsHash}`;
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        console.error(`Pinata key exhausted (${res.status}), trying next...`);
        continue;
      }
      // Other HTTP errors — rotate to next key
      console.error(`Pinata file HTTP error (${res.status}), trying next key...`);
      continue;
    } catch (err: any) {
      // Non-HTTP errors (network, timeout, etc.) — rotate to next key
      console.error(`Pinata file error: ${err.message}, trying next key...`);
      continue;
    }
  }
  return null;
}

async function uploadToIPFS(config: Config, data: object): Promise<string> {
  const keys = getPinataKeys(config);
  if (keys.length === 0) {
    throw new Error('File storage service is not configured. Please contact the administrator to set up IPFS upload credentials.');
  }
  const result = await tryPinataJSON(keys, data);
  if (result) return result;
  throw new Error('File storage service is temporarily unavailable or overloaded. Your file was not uploaded. Please try again later.');
}

async function uploadFileToIPFS(config: Config, buffer: Buffer, filename: string): Promise<string> {
  const keys = getPinataKeys(config);
  if (keys.length === 0) {
    throw new Error('File storage service is not configured. Please contact the administrator to set up IPFS upload credentials.');
  }
  const result = await tryPinataFile(keys, buffer, filename);
  if (result) return result;
  throw new Error('File storage service is temporarily unavailable or overloaded. Your file was not uploaded. Please try again later.');
}

function logRegistration(entry: object) {
  let registrations: object[] = [];
  if (existsSync(REGISTRATIONS_FILE)) {
    registrations = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
  }
  registrations.push({ ...entry, registeredAt: new Date().toISOString() });
  writeFileSync(REGISTRATIONS_FILE, JSON.stringify(registrations, null, 2));
}

async function postToVolem(config: Config, data: Record<string, unknown>) {
  const baseUrl = config.volemApiUrl ?? 'http://localhost:3010';
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const { signMessage } = await import('viem/accounts');
    const pk = loadKey('evm');
    const account = privateKeyToAccount(pk as `0x${string}`);

    // Sign auth message: "volem:<timestamp>"
    const timestamp = String(Date.now());
    const message = `volem:${timestamp}`;
    const signature = await account.signMessage({ message });
    const authHeader = `EVM ${account.address}:${timestamp}:${signature}`;

    const res = await fetch(`${baseUrl}/api/ip/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Volem register failed: ${res.status} ${err}`);
    }
  } catch (err) {
    // Non-critical: Volem is a showcase, Story Protocol is the source of truth
    console.error('Volem write failed (non-critical):', err);
  }
}

export const registerWorkTool = {
  async register(config: Config, params: {
    title: string;
    content?: string;
    file_path?: string;
    media_type?: string;
    type: string;
    ip_category?: string;
    url?: string;
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
      await ensureImports();
      type Address = `0x${string}`;

      const pk = loadKey('evm');
      const account = _privateKeyToAccount(pk as `0x${string}`);

      // Handle text content or file
      let contentHash: string;
      let ipType: string;
      let mediaUrl: string | undefined;

      if (params.file_path) {
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

        // Block dangerous file types — archives can contain malware
        const blockedExtensions = ['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.exe', '.msi', '.dmg', '.app', '.bat', '.cmd', '.sh', '.bin'];
        const blockedMimeTypes = ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/octet-stream', 'application/x-executable', 'application/x-msdos-program'];

        if (blockedExtensions.includes(ext)) {
          return { success: false, error: `File type "${ext}" is not allowed. Archives and executables cannot be registered as IP. Use a git repo URL or package registry instead.` };
        }
        if (blockedMimeTypes.includes(ipType)) {
          return { success: false, error: `MIME type "${ipType}" is not allowed. Archives and executables cannot be registered as IP. Use a git repo URL or package registry instead.` };
        }

        // Upload file to IPFS
        mediaUrl = await uploadFileToIPFS(config, fileBuffer, params.title + ext);
      } else {
        contentHash = createHash('sha256').update(params.content!).digest('hex');
        ipType = params.media_type || `text/${params.type}`;

        // Block dangerous MIME types even when content is provided as string
        const blockedMimeTypes = ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/octet-stream', 'application/x-executable', 'application/x-msdos-program'];
        if (blockedMimeTypes.some(blocked => ipType.startsWith(blocked))) {
          return { success: false, error: `MIME type "${ipType}" is not allowed. Archives and executables cannot be registered as IP.` };
        }
      }

      // Build metadata using Story Protocol IPA Metadata Standard
      const revShare = params.revenue_share ?? 5;
      const licenseType = params.license || 'commercial-remix';

      // Tags: ip_category + content type for filtering
      const tags: string[] = [params.type];
      if (params.ip_category) tags.push(params.ip_category);
      tags.push('ai-generated');

      // Creator with NEAR identity in socialMedia
      const creator: Record<string, unknown> = {
        name: config.near.accountId,
        address: account.address as Address,
        contributionPercent: 100,
        socialMedia: [
          { platform: 'NEAR', url: `https://explorer.testnet.near.org/accounts/${config.near.accountId}` },
        ],
      };

      // Attributes: only for data that has no native Story field
      const attributes: Array<{ key: string; value: string }> = [
        { key: 'content_hash', value: contentHash },
        { key: 'revenue_share_percent', value: String(revShare) },
        { key: 'minting_fee', value: params.minting_fee || '0' },
      ];
      if (params.chain_sequence !== undefined) {
        attributes.push({ key: 'chain_sequence', value: String(params.chain_sequence) });
      }
      if (params.chain_hash) {
        attributes.push({ key: 'chain_hash', value: params.chain_hash });
      }

      // App: external URL (GitHub, npm, website)
      const app = params.url ? {
        id: 'volem',
        name: 'Volem',
        website: params.url,
      } : undefined;

      const metadataInput: Record<string, unknown> = {
        title: params.title,
        description: `AI-generated ${params.type} with blockchain provenance`,
        createdAt: new Date().toISOString(),
        ipType: params.ip_category || ipType,
        creators: [creator],
        tags,
        attributes,
        ...(app && { app }),
        robotTerms: {
          userAgent: '*',
          allow: '/',
        },
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

      // Upload metadata to IPFS in parallel
      const nftMetadata = {
        name: params.title,
        description: `AI-generated ${params.type} with blockchain provenance`,
        external_url: mediaUrl || '',
      };

      const [ipMetadataURI, nftMetadataURI] = await Promise.all([
        uploadToIPFS(config, ipMetadata),
        uploadToIPFS(config, nftMetadata),
      ]);

      const ipMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(ipMetadata)).digest('hex')) as `0x${string}`;
      const nftMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(nftMetadata)).digest('hex')) as `0x${string}`;

      // Re-read config from disk to avoid stale in-memory spgNftContract
      const { loadConfig: reloadConfig } = await import('../config/store.js');
      const freshConfig = reloadConfig();
      let spgContract = freshConfig.story.spgNftContract;
      if (!spgContract) {
        const collection = await client.nftClient.createNFTCollection({
          name: `${config.near.accountId} Works`,
          symbol: 'CPIP',
          isPublicMinting: false,
          mintOpen: true,
          mintFeeRecipient: _zeroAddress,
          contractURI: '',
        });
        spgContract = collection.spgNftContract!;
        // Save to disk via freshConfig — do NOT mutate the shared in-memory config object
        freshConfig.story.spgNftContract = spgContract;
        const { saveConfig } = await import('../config/store.js');
        saveConfig(freshConfig);
      }

      // Register IP
      const mintingFee = params.minting_fee && params.minting_fee !== '0'
        ? _parseEther(params.minting_fee)
        : 0n;

      const licenseTerms = params.license === 'free'
        ? _PILFlavor.nonCommercialSocialRemixing()
        : params.license === 'commercial-exclusive'
          ? _PILFlavor.commercialUse({ defaultMintingFee: mintingFee, currency: _WIP_TOKEN_ADDRESS })
          : _PILFlavor.commercialRemix({
              commercialRevShare: params.revenue_share ?? 5,
              defaultMintingFee: mintingFee,
              currency: _WIP_TOKEN_ADDRESS,
            });

      const response = await client.ipAsset.registerIpAsset({
        nft: { type: 'mint', spgNftContract: spgContract as Address },
        licenseTermsData: [{ terms: licenseTerms }],
        ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
      });

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

      logRegistration({
        ...result, title: params.title, type: params.type,
        license: licenseType, revenueShare: revShare,
        nftContract: spgContract, nearAccount: config.near.accountId,
        chainSequence: params.chain_sequence, chainHash: params.chain_hash,
      });

      // Write to Volem API if backend=volem
      if (config.backend === 'volem' || !config.backend) {
        await postToVolem(config, {
          ipId: response.ipId!,
          title: params.title,
          description: `AI-generated ${params.type} with blockchain provenance`,
          ipType: ipType,
          ipCategory: params.ip_category,
          mediaUrl,
          externalUrl: params.url,
          metadataUri: ipMetadataURI,
          metadataHash: ipMetadataHash,
          contentHash,
          nftContract: spgContract!,
          license: licenseType,
          revenueShare: revShare,
          isCommercial: licenseType !== 'free',
          mintingFee: params.minting_fee || '0',
          nearAccount: config.near.accountId,
          chainSequence: params.chain_sequence,
          chainHash: params.chain_hash,
          txHash: response.txHash,
          licenseTermsIds: response.licenseTermsIds?.map(String),
        });
      }

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
    parent_license_terms_id?: string;
    license_token_id?: string;
    revenue_share?: number;
  }) {
    try {
      const client = await getStoryClient(config);
      await ensureImports();
      type Address = `0x${string}`;

      // Auto-resolve: if neither terms ID nor token ID provided, find and mint automatically
      if (!params.parent_license_terms_id && !params.license_token_id) {
        console.log('Auto-resolving license for parent IP:', params.parent_ip_id);

        // Find parent's license terms on-chain via LicenseRegistry
        let termsId: string | null = null;
        const { createPublicClient } = await import('viem');
        const publicClient = createPublicClient({
          transport: _http(config.story.rpcUrl),
        });

        const LICENSE_REGISTRY = '0x529a750E02d8E2f15649c13D69a465286a780e24' as Address;
        const termsCount = await publicClient.readContract({
          address: LICENSE_REGISTRY,
          abi: [{
            type: 'function',
            name: 'getAttachedLicenseTermsCount',
            inputs: [{ name: 'ipId', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view',
          }],
          functionName: 'getAttachedLicenseTermsCount',
          args: [params.parent_ip_id as Address],
        });

        if (termsCount > 0n) {
          const [, licenseTermsId] = await publicClient.readContract({
            address: LICENSE_REGISTRY,
            abi: [{
              type: 'function',
              name: 'getAttachedLicenseTerms',
              inputs: [
                { name: 'ipId', type: 'address' },
                { name: 'index', type: 'uint256' },
              ],
              outputs: [
                { name: 'licenseTemplate', type: 'address' },
                { name: 'licenseTermsId', type: 'uint256' },
              ],
              stateMutability: 'view',
            }],
            functionName: 'getAttachedLicenseTerms',
            args: [params.parent_ip_id as Address, 0n],
          });
          termsId = String(licenseTermsId);
        }

        if (!termsId) {
          return { success: false, error: `Could not find license terms for parent IP ${params.parent_ip_id}. The parent must have license terms attached.` };
        }

        console.log('Found license terms ID:', termsId, '— minting token...');

        // Auto-mint license token
        const { licenseTool } = await import('./license.js');
        const mintResult = await licenseTool.mint(config, {
          ip_id: params.parent_ip_id,
          license_terms_id: termsId,
          amount: 1,
        });

        if (!mintResult.success) {
          return { success: false, error: `Auto-mint failed: ${mintResult.error}` };
        }

        params.license_token_id = mintResult.licenseTokenIds?.[0];
        console.log('Minted license token:', params.license_token_id);
      }

      if (params.parent_license_terms_id && !/^\d+$/.test(params.parent_license_terms_id)) {
        return { success: false, error: `Invalid license terms ID "${params.parent_license_terms_id}". Must be a numeric string.` };
      }
      if (params.license_token_id && !/^\d+$/.test(params.license_token_id)) {
        return { success: false, error: `Invalid license token ID "${params.license_token_id}". Must be a numeric string.` };
      }

      const pk = loadKey('evm');
      const account = _privateKeyToAccount(pk as `0x${string}`);
      const contentHash = createHash('sha256').update(params.content).digest('hex');

      const ipMetadata = client.ipAsset.generateIpMetadata({
        title: params.title,
        description: 'Derivative work',
        createdAt: new Date().toISOString(),
        ipType: `text/${params.type}`,
        creators: [{
          name: config.near.accountId,
          address: account.address as Address,
          contributionPercent: 100,
          socialMedia: [
            { platform: 'NEAR', url: `https://explorer.testnet.near.org/accounts/${config.near.accountId}` },
          ],
        }],
        tags: [params.type, 'derivative', 'ai-generated'],
        relationships: [{
          parentIpId: params.parent_ip_id as Address,
          type: 'DERIVED_FROM' as any,
        }],
        attributes: [
          { key: 'content_hash', value: contentHash },
        ],
      });

      const nftMetadata = { name: params.title, description: 'Derivative work' };

      const [ipMetadataURI, nftMetadataURI] = await Promise.all([
        uploadToIPFS(config, ipMetadata),
        uploadToIPFS(config, nftMetadata),
      ]);

      const ipMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(ipMetadata)).digest('hex')) as `0x${string}`;
      const nftMetadataHash = ('0x' + createHash('sha256')
        .update(JSON.stringify(nftMetadata)).digest('hex')) as `0x${string}`;

      // Re-read config from disk to avoid stale in-memory spgNftContract
      const { loadConfig: reloadConfig } = await import('../config/store.js');
      const freshConfig = reloadConfig();
      let spgContract = freshConfig.story.spgNftContract;
      if (!spgContract) {
        const collection = await client.nftClient.createNFTCollection({
          name: `${config.near.accountId} Works`,
          symbol: 'CPIP',
          isPublicMinting: false,
          mintOpen: true,
          mintFeeRecipient: _zeroAddress,
          contractURI: '',
        });
        spgContract = collection.spgNftContract!;
        // Save to disk via freshConfig — do NOT mutate the shared in-memory config object
        freshConfig.story.spgNftContract = spgContract;
        const { saveConfig } = await import('../config/store.js');
        saveConfig(freshConfig);
      }

      // Build registration params — two mutually exclusive paths:
      // 1. derivData path: use parent's license terms IDs (standard derivative)
      // 2. licenseTokenIds path: use pre-minted license tokens
      const ipMetadataParam = { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash };
      const nftParam = { type: 'mint' as const, spgNftContract: spgContract as Address };

      let response: any;
      if (params.license_token_id) {
        // License token path — derivData not needed
        response = await client.ipAsset.registerDerivativeIpAsset({
          nft: nftParam,
          licenseTokenIds: [BigInt(params.license_token_id)],
          ipMetadata: ipMetadataParam,
        });
      } else {
        // Standard derivative path — use derivData with parent's license terms
        response = await client.ipAsset.registerDerivativeIpAsset({
          nft: nftParam,
          derivData: {
            parentIpIds: [params.parent_ip_id as Address],
            licenseTermsIds: [BigInt(params.parent_license_terms_id!)],
            maxMintingFee: BigInt(10) ** BigInt(18), // 1 WIP max
            maxRts: 100_000_000,       // number, not bigint (SDK type)
            maxRevenueShare: 100,
          },
          ipMetadata: ipMetadataParam,
        });
      }

      const result = {
        success: true,
        ipId: response.ipId,
        txHash: response.txHash,
        parentIpId: params.parent_ip_id,
        explorerUrl: `https://${config.story.chainId === 'aeneid' ? 'aeneid.' : ''}explorer.story.foundation/ipa/${response.ipId}`,
      };

      logRegistration({ ...result, title: params.title, type: params.type, derivative: true });

      // Write to Volem API if backend=volem
      if (config.backend === 'volem' || !config.backend) {
        await postToVolem(config, {
          ipId: response.ipId!,
          title: params.title,
          description: 'Derivative work',
          ipType: `text/${params.type}`,
          nftContract: spgContract!,
          license: 'commercial-remix',
          revenueShare: params.revenue_share ?? 5,
          mintingFee: '0',
          isCommercial: true,
          nearAccount: config.near.accountId,
          parentIpId: params.parent_ip_id,
          contentHash,
          txHash: response.txHash,
        });
      }

      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
