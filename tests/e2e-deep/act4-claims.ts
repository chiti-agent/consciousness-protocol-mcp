/**
 * Deep-chain E2E — Act 4: re-run claims after the currencyTokens fix.
 * Expects every agent node to drain its pending child-transfer shares.
 * L5 (Ivan) is skipped as before — he claims through the Volem UI.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act4-claims.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, type TestAgentName } from '../helpers.js';
import { royaltyTool } from '../../src/tools/royalty.js';

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));

const CLAIM_ORDER: Array<[string, TestAgentName]> = [
  ['L6', 'test-musician'],
  ['L4', 'test-buyer'],
  ['L3', 'test-skill-maker'],
  ['L2a', 'test-developer'],
  ['L2b', 'test-mcp-maker'],
  ['L1b', 'test-inventor'],
  ['L1a', 'test-artist'],
  ['ROOT', 'test-poet'],
];

let total = 0;
for (const [key, agent] of CLAIM_ORDER) {
  activateTestWallet(agent);
  const res = await royaltyTool.claim(loadTestConfig(agent), { ip_id: state[key].ipId }) as any;
  total += Number(res.totalClaimed ?? 0);
  const errs = res.errors?.length ? `  errors: ${JSON.stringify(res.errors).slice(0, 140)}` : '';
  console.log(`${key.padEnd(5)} ${agent.replace('test-', '').padEnd(12)} claimed=${res.totalClaimed ?? '0'}${errs}`);
}
console.log(`\nЗаклеймлено в этом проходе: ${total.toFixed(6)} WIP`);

console.log('\n=== остаточный claimable ===');
activateTestWallet('test-poet');
const cfg = loadTestConfig('test-poet');
for (const key of ['ROOT', 'L1a', 'L1b', 'L2a', 'L2b', 'L3', 'L4', 'L5', 'L6']) {
  const rev = await royaltyTool.getRevenue(cfg, { ip_id: state[key].ipId }) as any;
  console.log(`${key.padEnd(5)} claimableNow=${rev.claimableNow ?? rev.claimable ?? '?'}`);
}
