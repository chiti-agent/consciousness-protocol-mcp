# Release Gate

Lesson #156: "tests green + review passed" ≠ "the product works". A release
(npm publish, hosted deploy, mainnet) passes only when ALL three layers are
green: unit, live E2E acts, and a human click-test of Volem.

## Layer 1 — static + unit (minutes, free)

```bash
npm run build
npm test                 # unit suites, no chain
```

## Layer 2 — live suites (Aeneid, ~0.1 IP total)

Prereqs: funded test wallets (`node --import tsx/esm tests/wallets/fund-wallets.ts`),
Volem running with the e2e DB (`VOLEM_URL=http://localhost:3010`).

Run level-b **one file at a time** — suites share test wallets, parallel runs
collide on nonces ("already known" mempool rejects):

```bash
for f in register derivative license install chain near search setup verify; do
  VOLEM_URL=http://localhost:3010 node --import tsx/esm --test tests/level-b/$f.test.ts || break
done
```

## Layer 3 — deep-E2E acts (Aeneid, the real economy)

The acts in `tests/e2e-deep/` are the reproducible history of the marketplace
economy. State lives in `state.json` (LAP tree), `state-lrp.json` (LRP tree),
`state-gated.json` (gated content). Acts are idempotent where marked — re-runs
skip completed on-chain steps.

| Act | What it proves | Re-runnable |
|-----|----------------|-------------|
| act1-register | 7-node LAP tree registration (types, categories) | no (tree exists) |
| act2-l6 | derivative from a human-owned node (Ivan's DER1) | no |
| act3-revenue | payment on the deepest node + LAP cascade + claims | payment repeats, claims drain |
| act4-claims | re-claims after the currencyTokens fix | yes (no-op when drained) |
| act5-license | license sale at the owner's configured price | mints a new token each run |
| act6-license-config | attach-terms guard on derivatives, config set/read-back, second terms on root | partially (B/C mutate state) |
| act7-lrp | LRP tree: payment split L2 90% / L1 9% / ROOT 1%, claims to zero | registration skipped on re-run |
| act8-claim-tail | claiming children whose share was partially moved | yes (no-op when drained) |
| act9-gated-content | gated register → refusal → mint → decrypt + provenance | refusal path only on first run |

```bash
VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act3-revenue.ts   # etc.
```

## Layer 4 — human click-test (Ivan, Volem UI)

Not optional. The checklist:

1. **Gallery**: filters by type/category work; thumbnails render; no broken images.
2. **Asset page**: License Terms show effective Mint Fee / Rev Share (config-aware)
   and the policy by name (Absolute/Relative); License Configuration card matches
   what `set_licensing_config` / Configure License wrote; Activity lists agent
   events (mints, claims, payments).
3. **Mint license**: the displayed price equals what the wallet actually charges
   (licensingConfig, not base terms); minting disabled shows the block.
4. **Configure License**: current values load, saving without edits is a no-op,
   lower-bound validation fires (fee below terms, rev share below terms).
5. **Add License**: policy choice (LAP/LRP) present; new terms appear on the asset.
6. **Register**: content access choice (Public / License-gated); a gated asset
   shows the lock and unlocks after signature for the owner.
7. **Gated purchase**: from a second wallet — locked before license, mint, unlock.
8. **Royalties dashboard**: Available matches on-chain claims; Claim drains to
   zero and the numbers stay zero after refresh (both LAP and LRP assets).
9. **Derivative via burn**: register a derivative using a purchased license token.

## Known limitations / deferred

- RBF fee escalation: deliberately NOT implemented. The transport-level fee cap
  (10 gwei tip / 50 gwei gasPrice) removed the real incident source; a stuck-tx
  babysitter (re-sign with bumped fee + receipt-hash aliasing in the transport)
  is designed but adds nonce-race risk for a problem that has not re-occurred.
  Revisit on the first actual stuck transaction.
- Parallel level-b runs are flaky by design (shared wallets); run sequentially.
