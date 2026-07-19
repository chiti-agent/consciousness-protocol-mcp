/**
 * Story IP metadata provenance.
 *
 * CoreMetadataModule stores METADATA_URI and METADATA_HASH in the IP Account's
 * namespaced storage. Reading those values from the IP Account prevents a
 * mutable indexer record from becoming the provenance authority.
 */

import { createHash } from 'node:crypto';
import {
  createPublicClient,
  hexToString,
  http,
  pad,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import type { Config } from './config/store.js';
import { fetchIpfs } from './ipfs.js';

const CORE_METADATA_MODULE = '0x6E81a25C99C6e8430aeC7353325EB138aFE5DC16' as const;
const CORE_METADATA_NAMESPACE = pad(CORE_METADATA_MODULE, { size: 32 });
const METADATA_URI_KEY = stringToHex('METADATA_URI', { size: 32 });
const METADATA_HASH_KEY = stringToHex('METADATA_HASH', { size: 32 });

const IP_ACCOUNT_METADATA_ABI = [
  {
    type: 'function',
    name: 'getBytes',
    inputs: [{ name: 'namespace', type: 'bytes32' }, { name: 'key', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getBytes32',
    inputs: [{ name: 'namespace', type: 'bytes32' }, { name: 'key', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
] as const;

export type StoryIpMetadata = {
  title?: string;
  mediaUrl?: string;
  mediaType?: string;
  attributes?: Array<{ key?: string; value?: string }>;
};

export function verifyMetadataCommitment(raw: Buffer, expectedHash: Hex): StoryIpMetadata {
  const actualHash = `0x${createHash('sha256').update(raw).digest('hex')}` as Hex;
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`Story metadata hash mismatch: expected ${expectedHash}, received ${actualHash}`);
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new Error('Story metadata is not valid JSON');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Story metadata must be a JSON object');
  }
  return metadata as StoryIpMetadata;
}

export function getCommittedContentHash(metadata: StoryIpMetadata): string {
  const contentHash = metadata.attributes?.find((attribute) => attribute.key === 'content_hash')?.value;
  if (!contentHash || !/^[0-9a-fA-F]{64}$/.test(contentHash)) {
    throw new Error('Verified Story metadata has no valid content_hash attribute');
  }
  return contentHash.toLowerCase();
}

export async function readStoryIpMetadata(
  config: Config,
  ipId: string,
): Promise<{ metadata: StoryIpMetadata; metadataUri: string; metadataHash: Hex }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ipId)) throw new Error(`Invalid Story IP ID: ${ipId}`);

  const publicClient = createPublicClient({ transport: http(config.story.rpcUrl) });
  const [metadataUriBytes, metadataHash] = await Promise.all([
    publicClient.readContract({
      address: ipId as Address,
      abi: IP_ACCOUNT_METADATA_ABI,
      functionName: 'getBytes',
      args: [CORE_METADATA_NAMESPACE, METADATA_URI_KEY],
    }),
    publicClient.readContract({
      address: ipId as Address,
      abi: IP_ACCOUNT_METADATA_ABI,
      functionName: 'getBytes32',
      args: [CORE_METADATA_NAMESPACE, METADATA_HASH_KEY],
    }),
  ]);

  if (metadataUriBytes === '0x' || metadataHash === zeroHash) {
    throw new Error('Story IP has no committed metadata URI and hash');
  }

  const metadataUri = hexToString(metadataUriBytes);
  const { response } = await fetchIpfs(metadataUri, {
    preferredGateway: config.ipfs.gateway,
    timeoutMs: 15_000,
  });
  const raw = Buffer.from(await response.arrayBuffer());

  return {
    metadata: verifyMetadataCommitment(raw, metadataHash),
    metadataUri,
    metadataHash,
  };
}
