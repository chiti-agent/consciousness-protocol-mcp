/**
 * Volem license-event reporting. Story Protocol is the source of truth;
 * Volem's dashboard (Licenses counter, Total Claimed, Activity feed) is
 * computed from LicenseEvent rows, so MCP tools report their on-chain
 * operations here. All failures are non-critical and never fail the tool.
 */

import type { Config } from './config/store.js';
import { loadKey } from './config/store.js';

export type VolemEventType = 'LICENSE_ADDED' | 'LICENSE_MINTED' | 'ROYALTY_CLAIMED' | 'ROYALTY_PAID';

export interface VolemEvent {
  ip_id: string;
  event_type: VolemEventType;
  license_terms_id?: string;
  token_id?: string;
  tx_hash?: string;
  metadata?: Record<string, unknown>;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function postVolemEvent(config: Config, event: VolemEvent): Promise<void> {
  if (config.backend && config.backend !== 'volem') return;

  const baseUrl = config.volemApiUrl ?? 'http://localhost:3010';
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const pk = loadKey('evm');
    const account = privateKeyToAccount(pk as `0x${string}`);

    const timestamp = String(Date.now());
    const signature = await account.signMessage({ message: `volem:${timestamp}` });

    const txHash = event.tx_hash && TX_HASH_RE.test(event.tx_hash) ? event.tx_hash : undefined;

    const res = await fetch(`${baseUrl}/api/ip/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `EVM ${account.address}:${timestamp}:${signature}`,
      },
      body: JSON.stringify({
        ipId: event.ip_id,
        eventType: event.event_type,
        licenseTermsId: event.license_terms_id,
        tokenId: event.token_id,
        txHash,
        metadata: event.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Volem event failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('Volem event write failed (non-critical):', err);
  }
}
