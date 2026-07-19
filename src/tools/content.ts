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

const resolveIpfsUrl = (url: string, gateway?: string): string => {
  if (!url.startsWith('ipfs://')) return url;
  const base = gateway ?? 'https://gateway.pinata.cloud/ipfs/';
  return (base.endsWith('/') ? base : base + '/') + url.slice('ipfs://'.length);
};

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

      if (!asset.mediaUrl) {
        return { success: false, error: 'Asset has no media content (external URL only?)' };
      }

      const gated = asset.contentAccess === 'GATED';
      let key: string | undefined;
      let effectiveMime = asset.ipType ?? null;

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

      const blobRes = await fetch(resolveIpfsUrl(asset.mediaUrl, config.ipfs.gateway), { signal: AbortSignal.timeout(30_000) });
      if (!blobRes.ok) {
        return { success: false, error: `Failed to fetch content from IPFS: HTTP ${blobRes.status}` };
      }
      const raw = Buffer.from(await blobRes.arrayBuffer());
      const plain = gated ? decryptContent(raw, key!) : raw;

      // Provenance: the registered contentHash covers the plaintext
      const plainHash = createHash('sha256').update(plain).digest('hex');
      const provenanceVerified = asset.contentHash ? plainHash === asset.contentHash : null;

      const base = {
        success: true,
        ipId: params.ip_id,
        title: asset.title,
        mediaType: effectiveMime,
        gated,
        provenanceVerified,
        ...(provenanceVerified === false && {
          warning: 'Content hash mismatch — the delivered bytes do not match the registered contentHash.',
        }),
      };

      if (isTextMime(effectiveMime) && !params.output_path) {
        return { ...base, content: plain.toString('utf-8') };
      }

      const ext = effectiveMime ? '.' + (effectiveMime.split('/')[1] ?? 'bin') : (extname(asset.mediaUrl) || '.bin');
      const outPath = params.output_path ?? join(DOWNLOADS_DIR, `${params.ip_id}${ext}`);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, plain);
      return { ...base, savedTo: outPath, bytes: plain.length };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  },
};
