/** Volem registration writes shared by original and derivative registration. */

import type { Config } from './config/store.js';
import { jsonRequestBody, signedVolemRequest } from './volem/client.js';

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
  try {
    const { response } = await signedVolemRequest({
      config,
      action: 'ip.register',
      path: '/api/ip/register',
      body: jsonRequestBody(data),
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
