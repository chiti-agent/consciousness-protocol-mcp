/**
 * Content retrieval tool — fetch an asset's content, decrypting license-gated
 * works when this wallet is authorized (owner, license-token holder, or
 * derivative owner). The key comes from Volem's content-key endpoint; the
 * bytes come from IPFS; provenance is verified against the on-record
 * contentHash of the plaintext.
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { decryptContent } from '../content-crypto.js';
import { fetchIpfs } from '../ipfs.js';
import { getCommittedContentHash, readStoryIpMetadata, type StoryIpMetadata } from '../story-metadata.js';

const DOWNLOADS_DIR = join(homedir(), '.consciousness-protocol', 'downloads');

type VolemAsset = {
  ipId: string;
  title?: string;
  ipType?: string | null;
  mediaUrl?: string | null;
  contentHash?: string | null;
  contentAccess?: 'PUBLIC' | 'GATED';
  encryptedMediaType?: string | null;
};

async function volemAuthHeader(): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadKey('evm') as `0x${string}`);
  const timestamp = String(Date.now());
  const signature = await account.signMessage({ message: `volem:${timestamp}` });
  return `EVM ${account.address}:${timestamp}:${signature}`;
}

const isTextMime = (mime: string | null | undefined): boolean =>
  !!mime && (mime.startsWith('text/') || mime === 'application/json');

export function assertVolemMatchesStory(
  asset: Pick<VolemAsset, 'mediaUrl' | 'contentHash'>,
  metadata: StoryIpMetadata,
  committedContentHash: string,
): string {
  if (!metadata.mediaUrl) throw new Error('Verified Story metadata has no mediaUrl');
  if (asset.mediaUrl && asset.mediaUrl !== metadata.mediaUrl) {
    throw new Error('Volem mediaUrl does not match the verified Story metadata');
  }
  if (asset.contentHash && asset.contentHash.toLowerCase() !== committedContentHash) {
    throw new Error('Volem contentHash does not match the verified Story metadata');
  }
  return metadata.mediaUrl;
}

export const contentTool = {
  async get(config: Config, params: { ip_id: string; output_path?: string }) {
    try {
      const baseUrl = config.volemApiUrl ?? 'http://localhost:3010';

      const assetRes = await fetch(`${baseUrl}/api/ip/${params.ip_id}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!assetRes.ok) {
        return { success: false, error: `Asset not found on Volem (HTTP ${assetRes.status})` };
      }
      const asset = await assetRes.json() as VolemAsset;

      // Volem decides whether this wallet may receive the key. Provenance and
      // delivery location come from Story's on-chain metadata commitment.
      const { metadata } = await readStoryIpMetadata(config, params.ip_id);
      const committedContentHash = getCommittedContentHash(metadata);
      const mediaUrl = assertVolemMatchesStory(asset, metadata, committedContentHash);

      const gated = asset.contentAccess === 'GATED';
      let key: string | undefined;
      let effectiveMime = metadata.mediaType ?? asset.ipType ?? null;

      if (gated) {
        const keyRes = await fetch(`${baseUrl}/api/ip/${params.ip_id}/content-key`, {
          method: 'POST',
          headers: { 'Authorization': await volemAuthHeader() },
          signal: AbortSignal.timeout(15_000),
        });
        if (keyRes.status === 403) {
          return {
            success: false,
            error: 'Access denied: this content is license-gated. Mint a license token first (mint_license), then retry.',
          };
        }
        if (!keyRes.ok) {
          return { success: false, error: `Content key request failed: HTTP ${keyRes.status} ${await keyRes.text()}` };
        }
        const keyData = await keyRes.json() as { key: string; encryptedMediaType?: string | null };
        key = keyData.key;
        effectiveMime = keyData.encryptedMediaType ?? asset.encryptedMediaType ?? effectiveMime;
      }

      const { response: blobRes } = await fetchIpfs(mediaUrl, {
        preferredGateway: config.ipfs.gateway,
        timeoutMs: 30_000,
      });
      const raw = Buffer.from(await blobRes.arrayBuffer());
      const plain = gated ? decryptContent(raw, key!) : raw;

      // Success is impossible until plaintext matches the on-chain commitment.
      const plainHash = createHash('sha256').update(plain).digest('hex');
      if (plainHash !== committedContentHash) {
        throw new Error('Content hash mismatch: delivered plaintext does not match verified Story metadata');
      }

      const base = {
        success: true,
        ipId: params.ip_id,
        title: metadata.title ?? asset.title,
        mediaType: effectiveMime,
        gated,
        provenanceVerified: true,
      };

      if (isTextMime(effectiveMime) && !params.output_path) {
        return { ...base, content: plain.toString('utf-8') };
      }

      const ext = effectiveMime ? '.' + (effectiveMime.split('/')[1] ?? 'bin') : (extname(mediaUrl) || '.bin');
      const outPath = params.output_path ?? join(DOWNLOADS_DIR, `${params.ip_id}${ext}`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, plain);
      return { ...base, savedTo: outPath, bytes: plain.length };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
