/** Explicit authority boundary for test-wallet fallback funding. */
export function resolveMainFundingKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MAIN_WALLET_KEY;
}
