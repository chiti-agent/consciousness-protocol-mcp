#!/usr/bin/env node
/**
 * Container bootstrap — provisions ~/.consciousness-protocol/{config.json, keys/*.json}
 * from environment variables, reusing the already-tested setupAgent() logic so the
 * on-disk formats stay in lockstep with the application.
 *
 * Invoked once at container start by docker-entrypoint.sh, BEFORE the MCP server.
 *
 * Source-of-truth model: when wallet secrets are present in env, they are the
 * source of truth and this rewrites config.json + keys/* deterministically on every
 * boot (so rotating a Railway secret takes effect on redeploy). The hash chain
 * (chain.json / chain.lock) and registrations.json on the volume are NEVER touched.
 *
 * When NO wallet secret is in env, bootstrap skips entirely — supporting a
 * volume-provisioned deployment configured once via the `setup` MCP tool.
 *
 * Imports compiled output (dist/), so the image must be built before this runs.
 */
import { setupAgent } from '../dist/tools/setup.js';
import { loadConfig, saveConfig } from '../dist/config/store.js';

const env = process.env;

// No secrets in env -> assume the volume already holds a config provisioned manually.
if (!env.CP_EVM_PRIVATE_KEY && !env.CP_NEAR_PRIVATE_KEY) {
  console.error('[bootstrap] No CP_*_PRIVATE_KEY in env — assuming volume-provisioned config, skipping.');
  process.exit(0);
}

// If any secret is present, ALL of these must be present — fail loud, never half-configure.
const required = ['CP_AGENT_NAME', 'CP_EVM_PRIVATE_KEY', 'CP_NEAR_ACCOUNT', 'CP_NEAR_PRIVATE_KEY'];
const missing = required.filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(`[bootstrap] FATAL: missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

try {
  await setupAgent({
    agent_name: env.CP_AGENT_NAME,
    network: env.CP_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    near_account: env.CP_NEAR_ACCOUNT,
    near_private_key: env.CP_NEAR_PRIVATE_KEY,
    evm_private_key: env.CP_EVM_PRIVATE_KEY,
    pinata_jwt: env.CP_PINATA_JWT,
  });

  // setupAgent() does not set a search backend. search.ts defaults an unset backend
  // to 'volem' -> http://localhost:3005, which does not exist in the container and
  // costs a 10s timeout per search before falling back. Force a reachable backend:
  //   - 'story' when a Story API key is provided
  //   - 'local' otherwise (registrations.json only)
  // An explicit CP_BACKEND always wins.
  const cfg = loadConfig();
  const explicit = env.CP_BACKEND;
  if (explicit === 'volem' || explicit === 'story' || explicit === 'local') {
    cfg.backend = explicit;
  } else {
    cfg.backend = env.CP_STORY_API_KEY ? 'story' : 'local';
  }
  if (env.CP_VOLEM_API_URL) cfg.volemApiUrl = env.CP_VOLEM_API_URL;
  if (env.CP_STORY_API_KEY) cfg.storyApiKey = env.CP_STORY_API_KEY;
  saveConfig(cfg);

  console.error(
    `[bootstrap] Provisioned ${cfg.near.accountId} (network=${cfg.network}, backend=${cfg.backend}).`,
  );
} catch (err) {
  console.error('[bootstrap] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
}
