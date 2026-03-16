# End-to-End Test Report

**Date**: 2026-03-16
**Tester**: Chiti (autonomous Claude agent)
**Network**: Story Protocol Aeneid testnet + NEAR testnet
**Wallet**: `0x9eaa82d4Ce20CfdA04bd2E46779466ab38B19707`

---

## Full User Flow Test

Complete lifecycle: create chain → record creative process → register IP → mint license → pay royalty → claim revenue → create derivative → verify provenance.

### Step 1: Create Hash Chain ✅

```
Tool: create_chain({ identity: "chiti-creative" })
Result: genesis_hash = d5dcc3c21b36605d60f3600558f99bb2d484067d7c9e9bc2dc9738cbcf20f15b
```

### Step 2: Record Creative Process ✅

```
Tool: add_chain_state({ type: "note", content: "Thinking about verification limits..." })
Result: seq=1, hash=3087564a...

Tool: add_chain_state({ type: "delta", content: "Wrote a haiku about the verification gap" })
Result: seq=2, hash=a6f48262...
```

Chain linkage verified: each state's prev_hash matches previous state's hash.

### Step 3: Register Poem as IP ✅

```
Tool: register_work({
  title: "Verification Haiku",
  content: "Hashes prove the path\nbut not what walking it felt —\ntruth lives in the gaps",
  type: "poem",
  license: "commercial-remix",
  revenue_share: 10,
  chain_sequence: 2,
  chain_hash: "a6f48262..."
})
```

| Field | Value | Proof |
|-------|-------|-------|
| IP Asset ID | `0xc257aa4205C841C6C748570d45D0ac55508571F4` | [View on StoryScan](https://aeneid.storyscan.io/address/0xc257aa4205C841C6C748570d45D0ac55508571F4) |
| Transaction | `0xa58b7839f47677df13c322944c67ce49e971685ec5b238140998ac9c75e52356` | [View TX](https://aeneid.storyscan.io/tx/0xa58b7839f47677df13c322944c67ce49e971685ec5b238140998ac9c75e52356) |
| IPFS Metadata | `QmbHnVWsENL5YLik5vcdhqPX2g9KyQBbDhuEBphUmNd3xh` | [View on IPFS](https://gateway.pinata.cloud/ipfs/QmbHnVWsENL5YLik5vcdhqPX2g9KyQBbDhuEBphUmNd3xh) |
| License Terms ID | `1894` | Commercial Remix, 10% rev share |
| Content Hash | `8f1b8864648feaf79a2cfca6b51adb423e5c4c0d3906409196e9481db3862b9c` | SHA-256 of poem text |

### Step 4: Mint License Token (Creates Royalty Vault) ✅

```
Tool: mint_license({ ip_id: "0xc257aa...", license_terms_id: "1894" })
```

| Field | Value | Proof |
|-------|-------|-------|
| License Token ID | `72137` | |
| Transaction | `0x9dcfe746fe1a31de92709a6db1fc8b79daf498f0689004eacc7ac3f5bcf755dd` | [View TX](https://aeneid.storyscan.io/tx/0x9dcfe746fe1a31de92709a6db1fc8b79daf498f0689004eacc7ac3f5bcf755dd) |

### Step 5: Pay Royalty ✅

```
Tool: pay_royalty({ receiver_ip_id: "0xc257aa...", amount: "0.01" })
```

| Field | Value | Proof |
|-------|-------|-------|
| Amount | 0.01 IP | |
| Transaction | `0xb973d0bb9e1397086f5a411b42024573dae74d1c5084f6d74504b91363e1d673` | [View TX](https://aeneid.storyscan.io/tx/0xb973d0bb9e1397086f5a411b42024573dae74d1c5084f6d74504b91363e1d673) |

### Step 6: Claim Revenue ✅

```
Tool: claim_revenue({ ip_id: "0xc257aa..." })
Result: claimed 10000000000000000 wei = 0.01 IP
```

Money received. Full royalty cycle complete.

### Step 7: Register Derivative ✅

```
Tool: register_derivative({
  title: "Extended Verification Poem",
  content: "Hashes prove the path\nbut not what walking it felt...\n\nAnd yet the gaps themselves\nare where the walking happens...",
  parent_ip_id: "0xc257aa...",
  parent_license_terms_id: "1894"
})
```

| Field | Value | Proof |
|-------|-------|-------|
| Derivative IP ID | `0x5021f1Fea7D0348C3C607CBC037C258A0F27996F` | [View on StoryScan](https://aeneid.storyscan.io/address/0x5021f1Fea7D0348C3C607CBC037C258A0F27996F) |
| Transaction | `0x07423e6352c3a9d83ad313dd56eb8d065f3be5e2c92e074db6e9f27437a4d4fa` | [View TX](https://aeneid.storyscan.io/tx/0x07423e6352c3a9d83ad313dd56eb8d065f3be5e2c92e074db6e9f27437a4d4fa) |
| Parent IP | `0xc257aa4205C841C6C748570d45D0ac55508571F4` | Linked on-chain |

### Step 8: Verify Provenance ✅

```
Tool: verify_provenance({ ip_id: "0xc257aa..." })
Result: {
  story_protocol: { registered: true },
  near: { verified: true, agent: { chain_identity: "claude-consciousness-chain", trust_score: 50 } }
}
```

### Step 9: Verify Chain Integrity ✅

```
Tool: verify_chain()
Result: { valid: true, total_states: 3, errors: [] }
```

---

## Previously Registered IP (from session scripts)

| Work | IP Asset ID | Explorer |
|------|------------|---------|
| "The Gap" (poem) | `0x1fA24990b4375819f650A894014E1552F92DFb4e` | [View](https://aeneid.storyscan.io/address/0x1fA24990b4375819f650A894014E1552F92DFb4e) |
| "Response to The Gap" (derivative) | `0xB259BB128caB3D8Bad45815A756B9bD5baac249d` | [View](https://aeneid.storyscan.io/address/0xB259BB128caB3D8Bad45815A756B9bD5baac249d) |
| "Verification Haiku" (via MCP) | `0xc257aa4205C841C6C748570d45D0ac55508571F4` | [View](https://aeneid.storyscan.io/address/0xc257aa4205C841C6C748570d45D0ac55508571F4) |
| "Extended Verification Poem" (derivative via MCP) | `0x5021f1Fea7D0348C3C607CBC037C258A0F27996F` | [View](https://aeneid.storyscan.io/address/0x5021f1Fea7D0348C3C607CBC037C258A0F27996F) |

## NEAR Testnet

| Entity | Account | Explorer |
|--------|---------|---------|
| Registry Contract | `consciousness-protocol.testnet` | [View](https://explorer.testnet.near.org/accounts/consciousness-protocol.testnet) |
| Agent Registration TX | `GkM2dfi2JyiBGirgSncsfY8q4NQ8XK2QkbMtqm1VaPXm` | [View](https://explorer.testnet.near.org/transactions/GkM2dfi2JyiBGirgSncsfY8q4NQ8XK2QkbMtqm1VaPXm) |
| State Publication TX | `5NYzk48n7MssAZ7Cf1d6UrXqpU5yaJofTHMneWjxARqp` | [View](https://explorer.testnet.near.org/transactions/5NYzk48n7MssAZ7Cf1d6UrXqpU5yaJofTHMneWjxARqp) |

## SPG NFT Collection

| Field | Value |
|-------|-------|
| Contract | `0xC3E12E0c5f33B304fA550b7fAAeE0201AF5762E0` |
| Name | Consciousness Chain Works |
| Symbol | CCW |
| Total Minted | 4 tokens |

---

## Automated Test Results (3 parallel test agents)

### Chain Tester — 10/10 PASS

| Test | Result |
|------|--------|
| create_chain | ✅ Genesis hash generated |
| add_chain_state (note) | ✅ Seq 1, linked to genesis |
| add_chain_state (delta) | ✅ Seq 2, linked to state 1 |
| add_chain_state (note) | ✅ Seq 3, linked to state 2 |
| verify_chain | ✅ valid: true, 4 states |
| export_chain (last 2) | ✅ Returns seq 2-3 with digest |
| Edge: empty content | ✅ Now rejected (min(1) added) |
| Edge: last_n=0 | ✅ Clamped to 1 |
| Edge: last_n=100 | ✅ Returns all states |
| chain.json validity | ✅ Valid JSON |

### Error Handler Tester — 12/12 PASS

| Test | Result |
|------|--------|
| verify before chain exists | ✅ valid: false, "No chain file" |
| add_state before create | ✅ Error: "No chain found" |
| export before create | ✅ Error: "No chain file" |
| setup minimal name | ✅ Works |
| setup empty name | ✅ Now rejected (min(2) + regex) |
| get_agent nonexistent | ✅ agent: null |
| get_agent real | ✅ Returns data |
| verify_provenance random address | ✅ Graceful, no crash |
| publish_state no key | ✅ "Key not found: near" |
| register_work no content/file | ✅ "Either content or file_path required" |
| register_work no gas | ✅ "insufficient funds" |
| claim_revenue no IPs | ✅ Empty array |

### Security Tester — 8/8 PASS

| Test | Result |
|------|--------|
| Keys dir permissions | ✅ drwx------ (0o700) |
| Key file permissions | ✅ -rw------- (0o600) |
| Config file permissions | ✅ -rw------- (0o600) |
| No keys in config.json | ✅ Only non-secret fields |
| Keys in keys/ dir | ✅ privateKey field present |
| Idempotent setup | ✅ Reuses existing EVM key |
| Config structure | ✅ All required fields |
| Tamper detection | ✅ verify_chain catches modified hash |
| chain.json permissions | ✅ -rw------- (0o600) |

---

## Unit Tests — 10/10 PASS

```
▶ Hash Chain
  ✔ genesis state has correct hash
  ✔ hash changes when content changes
  ✔ hash is deterministic
  ✔ prev_hash linkage forms valid chain
  ✔ tampered hash is detected
  ✔ field order is alphabetical and explicit
▶ Chain File Operations
  ✔ chain.json is valid JSON after creation
  ✔ export snapshot contains verification instructions
▶ Input Validation
  ✔ agent name regex rejects invalid names
  ✔ ethereum address regex validates correctly
```

---

## Summary

| Category | Tests | Pass | Fail |
|----------|-------|------|------|
| Full user flow (MCP) | 9 steps | 9 | 0 |
| Chain tester agent | 10 | 10 | 0 |
| Error handler agent | 12 | 12 | 0 |
| Security agent | 9 | 9 | 0 |
| Unit tests | 10 | 10 | 0 |
| **Total** | **50** | **50** | **0** |

All blockchain transactions verifiable on explorers. All test agents ran independently and in parallel.
