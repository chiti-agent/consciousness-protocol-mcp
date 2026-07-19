/**
 * Deep-chain E2E — Act 8: claim the act5 tail.
 * Ivan's license sale (0.3 on DER1/L5) credited each LAP ancestor 10% (0.03);
 * act4 claims predate that sale, so ROOT/L1a/L2a/L3/L4 still hold 0.03 each.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act8-claim-tail.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, restoreOriginalWallet, type TestAgentName } from '../helpers.js';
import { royaltyTool } from '../../src/tools/royalty.js';

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));

const ORDER: Array<[string, TestAgentName]> = [
  ['L4', 'test-buyer'],
  ['L3', 'test-skill-maker'],
  ['L2a', 'test-developer'],
  ['L1a', 'test-artist'],
  ['ROOT', 'test-poet'],
];

for (const [key, agent] of ORDER) {
  activateTestWallet(agent);
  const cfg = loadTestConfig(agent);
  const res = await royaltyTool.claim(cfg, { ip_id: state[key].ipId }) as any;
  console.log(`${key.padEnd(5)} claimed=${res.totalClaimed}${res.errors ? ' errors=' + JSON.stringify(res.errors) : ''}`);
}

// verify zeroed
activateTestWallet('test-poet');
const cfg = loadTestConfig('test-poet');
for (const [key] of ORDER) {
  const rev = await royaltyTool.getRevenue(cfg, { ip_id: state[key].ipId }) as any;
  console.log(`${key.padEnd(5)} after: claimableNow=${rev.claimableNow}`);
}

restoreOriginalWallet();
console.log('act8 done');
