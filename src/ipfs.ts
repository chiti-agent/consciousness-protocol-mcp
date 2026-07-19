/**
 * Resilient IPFS reads. A configured gateway is preferred, but gateway-local
 * throttling or pin availability must not make immutable content unavailable.
 */

export const DEFAULT_IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
] as const;

function gatewayUrl(gateway: string, ipfsPath: string): string {
  const base = gateway.endsWith('/') ? gateway : `${gateway}/`;
  return `${base}${ipfsPath}`;
}

export function resolveIpfsUrls(uri: string, preferredGateway?: string): string[] {
  if (!uri.startsWith('ipfs://')) return [uri];

  const ipfsPath = uri.slice('ipfs://'.length);
  if (!ipfsPath) throw new Error('Invalid IPFS URI: missing CID');

  const gateways = [preferredGateway, ...DEFAULT_IPFS_GATEWAYS]
    .filter((gateway): gateway is string => Boolean(gateway));

  return [...new Set(gateways.map((gateway) => gatewayUrl(gateway, ipfsPath)))];
}

export async function fetchIpfs(
  uri: string,
  options: { preferredGateway?: string; timeoutMs?: number } = {},
): Promise<{ response: Response; url: string }> {
  const failures: string[] = [];

  for (const url of resolveIpfsUrls(uri, options.preferredGateway)) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (response.ok) return { response, url };
      failures.push(`${url} (HTTP ${response.status})`);
    } catch (error) {
      failures.push(`${url} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  throw new Error(`IPFS fetch failed across all gateways: ${failures.join('; ')}`);
}
