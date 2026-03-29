# MCP + Volem Test Design

**Date:** 2026-03-23
**Status:** Draft
**Tasks:** #42, #51

---

## Purpose

Full test coverage for consciousness-protocol-mcp (16 tools) + Volem API. Three levels: integration tests per tool, parallel multi-wallet stress testing, and end-to-end marketplace pipeline.

All tests run against real Story Protocol testnet (Aeneid) and NEAR testnet. No mocks.

## Three Levels

### Level B — Integration Tests
Each of 16 MCP tools tested individually. ~30 test cases. Catches bugs in single tools before combining them.

### Level C — Parallelism
7 wallets register simultaneously. Verifies no nonce conflicts, Volem handles multiple addresses, rate limiting works correctly.

### Level A — E2E Pipeline
Full marketplace cycle between agents: register → search → license → derivative → install_skill → royalty → provenance verification.

## 9 Asset Types

| # | Agent | Content | Delivery | Category | License |
|---|-------|---------|----------|----------|---------|
| 1 | poet | poem text | text content | literary-work | free |
| 2 | developer | .ts file | file_path | software | commercial-remix 5% |
| 3 | skill-maker | Claude skill | git clone (GitHub) | agent-skill | commercial-remix 10% + 0.01 WIP fee |
| 4 | mcp-maker | MCP server | IPFS .tgz | mcp-server | commercial-remix |
| 5 | artist | .png image | file_path | visual-art | commercial-remix 15% |
| 6 | musician | .mp3 audio | file_path | audio-composition | free |
| 7 | researcher | hypothesis | text content | hypothesis | free |
| 8 | inventor | .pdf patent | file_path | invention | commercial-exclusive + 0.05 WIP fee |
| 9 | npm-mcp | MCP server | npm install (by name) | mcp-server | free |

Each type tests a unique combination of delivery method + license type.

## Test Architecture

### File Structure

```
tests/
  fixtures/                    — test files
    generate.ts                — programmatic fixture generation
    test-poem.txt              — poem (~200 bytes)
    test-hypothesis.txt        — hypothesis (~300 bytes)
    test-code.ts               — TypeScript util (~500 bytes)
    test-image.png             — 4x4 PNG with gradient (~150 bytes)
    test-audio.mp3             — 1s silence, valid MP3 (~10KB)
    test-patent.pdf            — minimal PDF with text (~5KB)
    test-skill/SKILL.md        — minimal Claude skill (~200 bytes)
    test-mcp/                  — minimal npm MCP package (~1KB)
      package.json             — bin field, name: test-mcp-server
      index.js                 — stdio JSON-RPC hello, exits
  wallets/
    generate-wallets.ts        — generate 7 EVM keypairs deterministically
    fund-wallets.ts            — request WIP from Aeneid faucet
  level-b/                     — integration tests
    chain.test.ts
    setup.test.ts
    register.test.ts           — 9 asset types
    derivative.test.ts
    license.test.ts
    search.test.ts
    install.test.ts
    near.test.ts
    verify.test.ts
  level-c/                     — parallelism tests
    parallel-register.test.ts
    nonce-conflict.test.ts
    volem-multiuser.test.ts
    volem-search-consistency.test.ts
  level-a/                     — E2E pipeline
    marketplace-cycle.test.ts
```

### Test Runner

Node.js native test runner (`node --test`), already configured in package.json.

### Execution Order

1. `generate-wallets.ts` + `fund-wallets.ts` — once before all tests
2. Level B — sequential (each tool individually)
3. Level C — parallel tests
4. Level A — E2E (depends on B and C passing)

## Wallets and Identities

7 test agents, each with own EVM wallet:

| # | Name | Role | Registers |
|---|------|------|-----------|
| 1 | poet | Poet | poem (text), hypothesis (text) |
| 2 | developer | Developer | .ts code (file) |
| 3 | skill-maker | Skill Maker | Claude skill (git clone) |
| 4 | mcp-maker | MCP Maker | MCP server (npm .tgz + npm install) |
| 5 | artist | Artist | .png image (file) |
| 6 | musician | Musician | .mp3 audio (file) |
| 7 | inventor | Inventor | .pdf patent (file) |

Plus 8th wallet (buyer/installer) for E2E Act 3-5.

**Wallet generation:** Deterministic from seed phrase (reproducible across runs). Saved to `~/.consciousness-protocol/keys/test-{name}.json`.

**Funding:** Story testnet faucet. Fallback: transfer from main wallet `0x9eaa...`.

**Config per agent:** In-memory Config objects with unique EVM address, shared rpc/chainId/ipfs settings. Does not touch main `~/.consciousness-protocol/config.json`.

**NEAR accounts:** One shared NEAR testnet account for provenance tests (NEAR is optional in the flow).

## Level B — Integration Tests

### chain.test.ts (local, no network)
- `create_chain("test-agent")` → genesis state
- `add_chain_state("delta", "test content")` → seq:1, prev_hash = genesis hash
- `add_chain_state("note", "observation")` → seq:2, linked
- `verify_chain()` → integrity: true
- `export_chain(5)` → snapshot with last 5 states
- Duplicate `create_chain` → error or overwrite?

### setup.test.ts (network)
- `setup` with new agent_name → creates config, keys, NEAR account
- Repeat `setup` → idempotent (no crash)
- `setup` with existing keys → reuse, no overwrite

### register.test.ts (Story testnet, 5-15s each)
9 test cases, one per asset type:

| Test | Agent | Key params | Checks |
|------|-------|-----------|--------|
| text poem | poet | content="...", type=poem, license=free | ipId exists, IPFS uploaded, Volem recorded |
| ts file | developer | file_path=test-code.ts, type=code, license=commercial-remix | contentHash matches SHA256 of file |
| skill git | skill-maker | url=github.com/..., type=code, ip_category=agent-skill | externalUrl saved |
| mcp tgz | mcp-maker | file_path=test-mcp.tgz, ip_category=mcp-server | binary IPFS upload works |
| png image | artist | file_path=test-image.png, media_type=image/png | mediaUrl is valid IPFS |
| mp3 audio | musician | file_path=test-audio.mp3, media_type=audio/mpeg | IPFS upload, correct MIME |
| hypothesis | poet | content="...", type=analysis, ip_category=hypothesis | text IPFS upload |
| pdf patent | inventor | file_path=test-patent.pdf, media_type=application/pdf | binary upload |
| npm mcp | mcp-maker | url=npmjs.com/..., ip_category=mcp-server, license=free | externalUrl for npm |

### derivative.test.ts (depends on register)
- Derivative from free work (poet → artist) — passes without fee
- Derivative from commercial-remix (developer → another agent) — mint license first, then derivative
- Derivative from commercial-exclusive (inventor) — requires license
- Chain A → B → C — derivative of derivative

### license.test.ts
- `mint_license` for commercial asset → get tokenId
- `mint_license` for free asset → passes (nonCommercial terms)
- `pay_royalty` to IP with vault → success
- `claim_revenue` after royalty payment → balance > 0

### search.test.ts (depends on register)
- Search by query → finds by title
- Search by creator address → all works of that wallet
- Search by type filter → only poems
- Search without params → listOwn (local registrations)
- `get_asset` by ipId → full details with IPFS metadata
- Volem search vs local fallback (stop Volem, check fallback)

### install.test.ts (depends on register)
- Install skill from GitHub URL → git clone, SKILL.md exists
- Install from IPFS zip → unzip, files extracted
- Install from IPFS tgz → tar xzf, package.json exists
- Install npm by name → npm install, bin exists
- Install text content → SKILL.md written
- Install non-skill asset (image) → error: not installable
- Install paid skill → auto-mint license → install
- Repeat install → "already installed"

### near.test.ts
- `publish_state` → txHash returned
- `get_agent` → agent info from registry
- Publish two sequential states → prev_hash verified on contract

### verify.test.ts (depends on register + near)
- `verify_provenance` on asset with chain provenance → all checks pass
- `verify_provenance` on asset without provenance → partial result

## Level C — Parallelism Tests

### parallel-register.test.ts
Main test: 7 agents register simultaneously.
- All 7 wallets call `register_work` in parallel (Promise.all)
- Each registers their own asset type
- Checks: all 7 ipIds unique, all 7 in Volem, no nonce failures

### nonce-conflict.test.ts
Reproduce the original bug:
- One wallet, 3 parallel `register_work` → should get nonce conflict
- Negative test: confirms the problem is real and that separate wallets solve it
- Expected failure, documented

### volem-multiuser.test.ts
Volem API under load from different addresses:
- 7 agents POST `/api/ip/register` simultaneously
- Checks: all 7 in PostgreSQL, User upsert no conflicts, rate limit not triggered
- Separate: one agent sends 11 requests → 11th gets 429

### volem-search-consistency.test.ts
After parallel registration:
- GET `/api/ip/search` no params → all 7 assets
- GET `/api/ip/search?q=poem` → only poet's asset
- GET `/api/ip/search?owner={address}` → only that wallet's assets
- GET `/api/ip/search?category=mcp-server` → only MCP assets
- GET `/api/ip/agent/{address}` → agent profile with correct work count

## Level A — E2E Pipeline

One large scenario simulating real marketplace usage. Sequential, each step depends on previous.

### Act 1: Registration (7 agents in parallel)
- Poet: "Ode to Decentralization" (free, text)
- Developer: `validator-utils.ts` (commercial-remix 5%, file)
- Skill-maker: Claude skill (commercial-remix 10% + 0.01 WIP fee, git)
- MCP-maker: MCP server (commercial-remix, npm .tgz)
- Artist: `abstract-chain.png` (commercial-remix 15%, file)
- Musician: `ambient-blocks.mp3` (free, file)
- Inventor: `consensus-method.pdf` (commercial-exclusive + 0.05 WIP fee, file)
- All with chain_sequence + chain_hash for provenance
- **Check:** 7 ipIds, all in Volem, all on Story Explorer

### Act 2: Search and Discovery
- Developer searches `query="poem"` → finds Poet's work
- Artist searches `type="code"` → finds Developer's code
- Buyer (8th wallet) searches `category="agent-skill"` → finds skill
- `get_asset` on each found asset → metadata, license terms, IPFS content

### Act 3: Licensing
- Artist mints license on Poet's poem (free, no fee)
- Buyer mints license on Skill-maker's skill (pays 0.01 WIP)
- Buyer mints license on Inventor's patent (exclusive + 0.05 WIP)
- **Check:** licenseTokenIds returned, Volem recorded LICENSE_MINTED events

### Act 4: Derivatives
- Artist registers derivative: "Visual Ode" (png) from Poet's poem
- Developer registers derivative: "Extended Utils" from own code (self-derivative)
- **Check:** parentIpId correct, relationships in metadata, Volem shows link

### Act 5: Install Skill
- Buyer calls `install_skill` on Claude skill → git clone, installed to ~/.claude/skills/
- Buyer calls `install_skill` on MCP server (.tgz) → downloaded from IPFS, extracted
- Buyer tries `install_skill` on Artist's image → error "not installable"
- Buyer calls `install_skill` on npm MCP → npm install
- **Check:** directories exist, SKILL.md / package.json present

### Act 6: Royalties
- Buyer pays royalty to Developer via `pay_royalty`
- Developer calls `claim_revenue` → receives WIP
- **Check:** balance changed

### Act 7: Provenance
- `publish_state` to NEAR for Poet and Developer
- `verify_provenance` on Poet's poem → Story metadata ✓, NEAR state ✓, chain hash ✓
- `verify_provenance` on Artist's derivative → parent chain verified

### Act 8: Cleanup
- Delete installed skills from ~/.claude/skills/
- Keep testnet data (let it live)

## Running

### Commands

```bash
# Preparation (once)
yarn test:setup          # generate-wallets + fund-wallets + generate fixtures

# Individual levels
yarn test:b              # integration tests (~3-5 min on testnet)
yarn test:c              # parallelism (~1 min)
yarn test:a              # E2E pipeline (~5-10 min)

# Everything
yarn test:all            # setup → B → C → A sequentially
```

### Prerequisites
1. Volem postgres: `docker compose -f /path/to/volem/docker-compose.yml up -d`
2. Volem dev server: `cd /path/to/volem && yarn dev` (localhost:3005)
3. Story testnet (Aeneid) accessible
4. NEAR testnet accessible
5. Pinata JWT configured (for IPFS uploads)

### Timeouts
- Story testnet tx: 30s each
- IPFS upload: 60s
- Volem API: 10s
- Level B total: 5 min max
- Level A total: 10 min max

### Report
Each level outputs summary: passed/failed/skipped. On fail: ipId, txHash, error message for explorer debugging.

## Implementation Prereqs

Before writing tests, need to update `install_skill` tool to support:
1. ~~git clone~~ (done)
2. ~~IPFS zip~~ (done)
3. **IPFS tgz** — add tar.gz detection and extraction
4. **npm install** — add npm package install by name
5. ~~text content~~ (done)

## Not Doing (Yet)
- CI/GitHub Actions — testnet tests are slow and depend on external services
- Mocks — all tests on real testnet
- Load testing beyond 7 parallel agents
- Mainnet testing
