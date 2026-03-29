/**
 * validator-utils.ts — Test fixture for IP registration.
 * Utility functions for blockchain validator operations.
 */

export interface ValidatorInfo {
  address: string;
  moniker: string;
  commission: number;
  tokens: bigint;
  status: 'bonded' | 'unbonded' | 'unbonding';
}

export function formatCommission(rate: number): string {
  return (rate * 100).toFixed(2) + '%';
}

export function isActive(validator: ValidatorInfo): boolean {
  return validator.status === 'bonded' && validator.tokens > 0n;
}

export function sortByTokens(validators: ValidatorInfo[]): ValidatorInfo[] {
  return [...validators].sort((a, b) =>
    a.tokens > b.tokens ? -1 : a.tokens < b.tokens ? 1 : 0
  );
}
