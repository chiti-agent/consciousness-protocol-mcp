/**
 * Fee guards for Story RPC transports.
 *
 * The node's eth_maxPriorityFeePerGas suggestion is a percentile heuristic over
 * recent transactions: a handful of overpaying spammers can poison it (observed
 * on Aeneid 2026-07-03: 500 gwei suggested while block base fee was ~0, so one
 * registration burned 0.58 IP in pure tips). viem and story-sdk sign whatever
 * the node suggests, so the clamp lives at the transport layer — every client
 * built from cappedHttp() inherits it on all SDK code paths. Base fee is never
 * touched: during real congestion the network price is paid as usual, only the
 * tip is bounded.
 */
import type { http as viemHttp, HttpTransport } from 'viem';

/** Max voluntary validator tip (EIP-1559 maxPriorityFeePerGas). */
export const MAX_PRIORITY_FEE_WEI = 10_000_000_000n; // 10 gwei

/** Max legacy gas price (eth_gasPrice path, non-1559 senders). */
export const MAX_GAS_PRICE_WEI = 50_000_000_000n; // 50 gwei

const FEE_CAPS: Record<string, bigint> = {
  eth_maxPriorityFeePerGas: MAX_PRIORITY_FEE_WEI,
  eth_gasPrice: MAX_GAS_PRICE_WEI,
};

/**
 * Wrap viem's http transport so fee-suggestion RPC responses are clamped.
 * httpFn is passed in (not imported) to keep viem lazy-loaded, matching the
 * import style of the tool modules.
 */
export function cappedHttp(httpFn: typeof viemHttp, url?: string): HttpTransport {
  const base = httpFn(url);
  return ((opts: Parameters<HttpTransport>[0]) => {
    const transport = base(opts);
    const baseRequest = transport.request.bind(transport);
    return {
      ...transport,
      async request(args: { method: string }, options?: unknown) {
        const result = await (baseRequest as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        const cap = FEE_CAPS[args.method];
        if (cap !== undefined && typeof result === 'string' && result.startsWith('0x')) {
          try {
            if (BigInt(result) > cap) return `0x${cap.toString(16)}`;
          } catch {
            // non-numeric hex — pass through untouched
          }
        }
        return result;
      },
    };
  }) as HttpTransport;
}
