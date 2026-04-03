# MCP Registration Code Audit

**Date**: 2026-04-03
**Auditor**: Blockchain Agent
**Scope**: `src/tools/register-work.ts`, `src/tools/royalty.ts`
**SDK**: `@story-protocol/core-sdk` (bundled ESM)

---

## registerWork (IP Registration)

### Current behavior

`registerWorkTool.register()` (line 186) calls `client.ipAsset.registerIpAsset()` with:
- `nft: { type: 'mint', spgNftContract }` — triggers `handleMintNftRegistration` in the SDK
- `licenseTermsData: [{ terms: licenseTerms }]` — present, no `royaltyShares`

**SDK routing path**: `registerIpAsset` -> `handleMintNftRegistration` -> since `licenseTermsData` is present but no `royaltyShares`, calls `mintAndRegisterIpAssetWithPilTerms`.

This is **correct** for standalone IP registration.

### Bugs found

**Bug R1: Post-registration license token mint may fail silently**
Lines 388-395: After registration, the code mints a license token to "create vault". However:
1. The vault is NOT created by minting a license token. The vault is created when a derivative registers against this IP. Minting a license token just creates a transferable token.
2. If `response.licenseTermsIds` is undefined or empty (which can happen), the mint is silently skipped.
3. This is a wasted transaction (gas cost) with no functional purpose for vault creation.

**Severity**: Low (wastes gas, doesn't break anything)

**Bug R2: `licenseTermsData` missing `licensingConfig`**
The SDK type `LicenseTermsDataInput` expects `{ terms, licensingConfig? }`. The code passes `{ terms: licenseTerms }` without `licensingConfig`. This works because `licensingConfig` is optional and defaults are applied by the SDK, but it means features like `maxLicenseTokens` or custom `licensingHook` are never configurable.

**Severity**: Informational (works correctly with defaults)

### Recommended fix

Remove the license token minting at lines 388-395. It serves no purpose for vault creation. If the intent is to pre-mint a license token for future derivative use, document that explicitly.

---

## registerDerivative (Derivative Registration)

### Current behavior

`registerWorkTool.registerDerivative()` (line 447) calls `client.ipAsset.registerIpAsset()` with:
- `nft: { type: 'mint', spgNftContract }` — triggers `handleMintNftRegistration`
- `licenseTermsData` — present (commercialRemix terms for the derivative)
- `derivData` — present (parent IP IDs, license terms IDs)
- `licenseTokenIds` — conditionally present

### Bugs found

**BUG D1 (CRITICAL): Wrong SDK method called — `registerIpAsset` instead of `registerDerivativeIpAsset`**

The code calls `client.ipAsset.registerIpAsset()` at line 622. This is the **non-derivative** registration entry point.

**SDK routing analysis** of `registerIpAsset` (SDK source lines 11561-11611):
```
registerIpAsset(request):
  1. Extracts: nft, licenseTermsData, royaltyShares (NOT derivData, NOT licenseTokenIds)
  2. If nft.type === "mint" → handleMintNftRegistration(request)
```

`handleMintNftRegistration` (SDK source lines 11970-12011):
```
handleMintNftRegistration(request):
  1. Extracts: nft, ipMetadata, txOptions, options, licenseTermsData, royaltyShares
     ⚠️ Does NOT extract derivData or licenseTokenIds
  2. If licenseTermsData && royaltyShares → mintAndRegisterIpAndAttachPilTermsAndDistributeRoyaltyTokens
  3. If licenseTermsData → mintAndRegisterIpAssetWithPilTerms  ← THIS IS THE PATH TAKEN
  4. Else → mintAndRegisterIp
```

**Result**: The `derivData` and `licenseTokenIds` fields in the request object are **completely ignored**. The SDK calls `mintAndRegisterIpAssetWithPilTerms`, which:
- Mints a new NFT
- Registers it as a standalone IP
- Attaches the derivative's OWN license terms (commercialRemix)
- Does NOT establish any parent-child relationship on-chain
- Does NOT link to the parent IP
- Does NOT create a royalty vault tied to the parent

**This is the root cause of the "no vault created" issue.** The derivative is registered as an independent IP with no connection to its parent.

**Severity**: CRITICAL

**BUG D2 (HIGH): `licenseTermsData` on derivative creates conflicting license**

Lines 608-613: The derivative attaches its OWN `commercialRemix` license terms with `defaultMintingFee: 0n`. Even if we fix D1, providing both `licenseTermsData` AND `derivData` to `registerDerivativeIpAsset` would be invalid — `registerDerivativeIpAsset` does NOT accept `licenseTermsData`. It accepts `derivData` (parent terms) or `licenseTokenIds`, not new terms for the derivative.

A derivative inherits its license terms from its parent. Attaching separate terms is semantically wrong and would fail with the correct SDK method.

**Severity**: High (must be removed when fixing D1)

**BUG D3 (MEDIUM): `derivData` structure is incorrect**

Lines 596-604: The `derivData` is built as a plain object with `Record<string, unknown>` type:
```typescript
const derivData: Record<string, unknown> = {
  parentIpIds: [params.parent_ip_id as Address],
  maxMintingFee: BigInt(10) ** BigInt(18),
  maxRts: 100_000_000n,       // ← Should be number, not bigint
  maxRevenueShare: 100,
};
```

Per SDK type `DerivativeDataInput`:
- `maxRts` should be `number` (not `bigint`). Value `100_000_000n` vs expected `100_000_000`.
- `licenseTermsIds` is conditionally added but should always be present when `licenseTokenIds` is not used. The SDK type makes `licenseTermsIds` required in `DerivativeDataInput`.

**Severity**: Medium (bigint may cause type coercion issues in SDK)

**BUG D4 (MEDIUM): Mutual exclusion of `licenseTermsIds` and `licenseTokenIds` not enforced**

The code has a path where both could theoretically be set (if `license_token_id` was auto-minted AND `parent_license_terms_id` was also provided). The correct SDK usage is: either `derivData` (with `licenseTermsIds`) OR `licenseTokenIds`, not both simultaneously.

**Severity**: Medium

### Root cause of "no vault created" issue

1. `registerIpAsset()` is called instead of `registerDerivativeIpAsset()`
2. The SDK's `registerIpAsset` ignores `derivData` completely
3. The on-chain contract `mintAndRegisterIpAndAttachPILTerms` is called, which creates a standalone IP
4. No derivative relationship exists, so no royalty flow path exists
5. No vault is deployed because vaults are created during derivative registration

### Recommended fix (with exact SDK method and params)

Replace the call at line 622 with `client.ipAsset.registerDerivativeIpAsset()`:

```typescript
// Remove licenseTermsData — derivatives inherit from parent
const registerParams = {
  nft: { type: 'mint' as const, spgNftContract: spgContract as Address },
  derivData: {
    parentIpIds: [params.parent_ip_id as Address],
    licenseTermsIds: [BigInt(params.parent_license_terms_id!)],
    maxMintingFee: BigInt(10) ** BigInt(18),  // 1 WIP
    maxRts: 100_000_000,                      // number, not bigint
    maxRevenueShare: 100,
  },
  ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
};

// OR when using license tokens:
const registerParamsWithTokens = {
  nft: { type: 'mint' as const, spgNftContract: spgContract as Address },
  licenseTokenIds: [BigInt(params.license_token_id!)],
  ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash },
};

const response = await client.ipAsset.registerDerivativeIpAsset(
  params.license_token_id ? registerParamsWithTokens : registerParams
);
```

**SDK routing of `registerDerivativeIpAsset`** with `nft.type === "mint"`:
- `handleMintNftDerivativeRegistration`
  - If `royaltyShares && derivData` → `mintAndRegisterIpAndMakeDerivativeAndDistributeRoyaltyTokens`
  - If `derivData` → `mintAndRegisterIpAndMakeDerivative` **<-- correct path**
  - Else → `mintAndRegisterIpAndMakeDerivativeWithLicenseTokens`

This will properly establish the parent-child relationship on-chain and create a royalty vault.

---

## royalty.ts

### Current behavior

**`pay` function** (line 10): Calls `client.royalty.payRoyaltyOnBehalf()` with:
- `receiverIpId`: the target IP
- `payerIpId: zeroAddress`
- `token: WIP_TOKEN_ADDRESS`
- `amount`: parsed from user input

**`claim` function** (line 47): Calls `client.royalty.claimAllRevenue()` with:
- `ancestorIpId`: the IP to claim from
- `claimer: account.address` (wallet address)
- `currencyTokens: [WIP_TOKEN_ADDRESS]`
- `childIpIds: []`
- `royaltyPolicies: []`

### Bugs found

**BUG Y1 (LOW): `payerIpId: zeroAddress` is correct for external payments**

`zeroAddress` as `payerIpId` means the payment comes from an external party (not from another IP). This is the correct usage for direct royalty payments from a wallet to an IP. Not a bug.

**Severity**: Not a bug (correct usage)

**BUG Y2 (HIGH): `childIpIds: []` and `royaltyPolicies: []` in `claimAllRevenue`**

Per the SDK type `ClaimAllRevenueRequest`:
- `childIpIds`: "The addresses of the child IPs from which royalties are derived"
- `royaltyPolicies`: "royaltyPolicies[i] governs the royalty flow for childIpIds[i]"

Passing empty arrays means: claim revenue only from the IP's own vault, ignoring any royalties flowing from child derivatives. If the IP has derivatives that generated royalties, those royalties will NOT be claimed.

However, the `claimAllRevenue` SDK method may handle empty arrays by claiming all available revenue. This needs verification against the SDK implementation. If the SDK interprets empty arrays as "claim everything available", this is correct. If it interprets them as "no children to claim from", revenue from derivatives will be missed.

**Severity**: High (potential missed revenue from derivatives — needs SDK verification)

**BUG Y3 (MEDIUM): `claimer` is wallet address, not IP ID**

Per the SDK docs: "This is normally the ipId of the ancestor IP if the IP has all royalty tokens. Otherwise, this would be the address that is holding the ancestor IP royalty tokens."

The code passes `account.address` (wallet), not the `ipId`. This is correct ONLY if the wallet holds the royalty tokens directly (e.g., after they were transferred from the IP vault). If the royalty tokens are still in the IP's vault (which is the default after registration), the claimer should be the `ipId` itself.

However, the SDK's `claimOptions.autoTransferAllClaimedTokensFromIp` defaults to `true`, which may handle this case. Needs verification.

**Severity**: Medium (may silently fail for IPs where wallet doesn't hold royalty tokens)

**BUG Y4 (LOW): Silent error swallowing in claim loop**

Line 99: `catch {}` silently ignores all errors during claim. While the comment says "Skip IPs that have no vault or no revenue", this also hides legitimate errors (network failures, contract reverts due to bugs, etc.). At minimum, errors should be logged.

**Severity**: Low (debugging difficulty)

### Recommended fix

```typescript
// For claim: pass ipId as claimer when the IP holds its own royalty tokens
const result = await client.royalty.claimAllRevenue({
  ancestorIpId: ipId as Address,
  claimer: ipId as Address,  // IP itself is the claimer
  currencyTokens: [WIP_TOKEN_ADDRESS],
  childIpIds: childIpIds,     // Must be populated with known derivatives
  royaltyPolicies: royaltyPolicies,  // Corresponding policies
});
```

For `childIpIds` and `royaltyPolicies`: these need to be populated from the registration log or on-chain query. The current empty-array approach may work if the SDK handles it, but explicit child IPs ensure complete revenue collection.

---

## SDK Routing Analysis

### How `registerIpAsset` decides which contract to call

```
registerIpAsset(request)
├── nft.type === "minted"
│   └── handleMintedNftRegistration(request)
│       ├── licenseTermsData + royaltyShares → registerIPAndAttachLicenseTermsAndDistributeRoyaltyTokens
│       ├── licenseTermsData only           → registerIpAndAttachPilTerms
│       └── neither                          → registerIp (basic)
│
└── nft.type === "mint"
    └── handleMintNftRegistration(request)
        ├── licenseTermsData + royaltyShares → mintAndRegisterIpAndAttachPilTermsAndDistributeRoyaltyTokens
        ├── licenseTermsData only           → mintAndRegisterIpAssetWithPilTerms
        └── neither                          → mintAndRegisterIp (basic)
```

**Key finding**: `registerIpAsset` NEVER reads `derivData` or `licenseTokenIds`. These fields are exclusive to `registerDerivativeIpAsset`.

### How `registerDerivativeIpAsset` decides which contract to call

```
registerDerivativeIpAsset(request)
├── Validation: royaltyShares requires derivData
├── Validation: either derivData or licenseTokenIds must be present
│
├── nft.type === "minted"
│   └── handleMintedNftDerivativeRegistration(request)
│       ├── royaltyShares + derivData → registerDerivativeIpAndAttachLicenseTermsAndDistributeRoyaltyTokens
│       ├── derivData only            → registerDerivativeIp
│       └── licenseTokenIds only      → registerIpAndMakeDerivativeWithLicenseTokens
│
└── nft.type === "mint"
    └── handleMintNftDerivativeRegistration(request)
        ├── royaltyShares + derivData → mintAndRegisterIpAndMakeDerivativeAndDistributeRoyaltyTokens
        ├── derivData only            → mintAndRegisterIpAndMakeDerivative
        └── licenseTokenIds only      → mintAndRegisterIpAndMakeDerivativeWithLicenseTokens
```

### Parameter combinations and their effects

| `licenseTermsData` | `derivData` | `licenseTokenIds` | `royaltyShares` | Method called | Result |
|---|---|---|---|---|---|
| Yes | - | - | - | `registerIpAsset` → `mintAndRegisterIpAssetWithPilTerms` | Standalone IP with license |
| Yes | - | - | Yes | `registerIpAsset` → `mintAndRegisterIpAndAttachPilTermsAndDistributeRoyaltyTokens` | Standalone IP with license + royalty distribution |
| - | - | - | - | `registerIpAsset` → `mintAndRegisterIp` | Basic standalone IP |
| - | Yes | - | - | `registerDerivativeIpAsset` → `mintAndRegisterIpAndMakeDerivative` | Derivative linked to parent |
| - | Yes | - | Yes | `registerDerivativeIpAsset` → `mintAndRegisterIpAndMakeDerivativeAndDistributeRoyaltyTokens` | Derivative with royalty distribution |
| - | - | Yes | - | `registerDerivativeIpAsset` → `mintAndRegisterIpAndMakeDerivativeWithLicenseTokens` | Derivative using license tokens |
| **Yes** | **Yes** | **-** | **-** | **`registerIpAsset` ignores derivData** | **BUG: standalone IP, no derivative** |

The last row is exactly what the current `registerDerivative` code does.

---

## Summary of Critical Issues

| ID | Severity | File | Description |
|---|---|---|---|
| D1 | CRITICAL | register-work.ts:622 | Wrong method: `registerIpAsset` instead of `registerDerivativeIpAsset`. Derivatives are registered as standalone IPs. |
| D2 | HIGH | register-work.ts:608-613 | `licenseTermsData` must be removed — derivatives inherit parent terms. |
| D3 | MEDIUM | register-work.ts:599 | `maxRts` is `bigint` but SDK expects `number`. |
| Y2 | HIGH | royalty.ts:85-86 | Empty `childIpIds`/`royaltyPolicies` may miss derivative revenue. |
| Y3 | MEDIUM | royalty.ts:84 | `claimer` should likely be `ipId`, not wallet address. |
| R1 | LOW | register-work.ts:388-395 | Unnecessary license token mint (doesn't create vault). |
| Y4 | LOW | royalty.ts:99 | Silent error swallowing hides real failures. |
