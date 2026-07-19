/** Volem registration writes shared by original and derivative registration. */

import type { Config } from './config/store.js';
import { loadKey } from './config/store.js';

export type VolemWriteResult =
  | { ok: true }
  | { ok: false; error: string };

export function supportsGatedRegistration(config: Config): boolean {
  return (config.backend ?? 'volem') === 'volem';
}

export async function postToVolem(
  config: Config,
  data: Record<string, unknown>,
): Promise<VolemWriteResult> {
  const baseUrl = config.volemApiUrl ?? 'http://localhost:3010';
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(loadKey('evm') as `0x${string}`);
    const timestamp = String(Date.now());
    const signature = await account.signMessage({ message: `volem:${timestamp}` });

    const response = await fetch(`${baseUrl}/api/ip/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `EVM ${account.address}:${timestamp}:${signature}`,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true };

    const detail = await response.text();
    const error = `Volem register failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`;
    console.error(error);
    return { ok: false, error };
  } catch (cause) {
    const error = `Volem write failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    console.error(error);
    return { ok: false, error };
  }
}
