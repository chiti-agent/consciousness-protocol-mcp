/**
 * Deep-chain E2E — Act 3: revenue flow through the 6-level tree.
 *
 * 1. buyer pays 0.1 WIP royalty on L6 (usage payment for Genesis Echo).
 * 2. Snapshot claimable per node (LAP cascade check: every ancestor of L6
 *    holds 10% of every downstream revenue event).
 * 3. Each agent owner claims its own node bottom-up. L5 (DER1) is skipped —
 *    Ivan claims it himself through the Volem UI.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act3-revenue.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, type TestAgentName } from '../helpers.js';
import { royaltyTool } from '../../src/tools/royalty.js';

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));

const snapshot = async (label: string) => {
  console.log(`\n=== claimable по узлам (${label}) ===`);
  activateTestWallet('test-poet'); // getRevenue is read-only; any key works
  const cfg = loadTestConfig('test-poet');
  for (const key of ['ROOT', 'L1a', 'L1b', 'L2a', 'L2b', 'L3', 'L4', 'L5', 'L6']) {
    const node = state[key];
    if (!node) continue;
    const rev = await royaltyTool.getRevenue(cfg, { ip_id: node.ipId });
    const claimable = (rev as any).claimableNow ?? (rev as any).claimable ?? '?';
    console.log(`${key.padEnd(5)} ${String(node.agent).padEnd(12)} claimableNow=${claimable}`);
  }
};

// 1. Payment
activateTestWallet('test-buyer');
console.log('buyer платит 0.1 WIP роялти на L6 (Genesis Echo)...');
const pay = await royaltyTool.pay(loadTestConfig('test-buyer'), {
  receiver_ip_id: state.L6.ipId,
  amount: '0.1',
});
if (!(pay as any).success) throw new Error(`pay failed: ${(pay as any).error}`);
console.log('payment tx:', (pay as any).txHash);

await snapshot('после платежа, до клеймов');

// 2. Claims bottom-up, each by its owner. L5 намеренно пропущен (Иван, UI).
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

console.log('\n=== клеймы (снизу вверх) ===');
let totalClaimed = 0;
for (const [key, agent] of CLAIM_ORDER) {
  activateTestWallet(agent);
  const res = await royaltyTool.claim(loadTestConfig(agent), { ip_id: state[key].ipId });
  const r = res as any;
  const claimed = Number(r.totalClaimed ?? 0);
  totalClaimed += claimed;
  const errs = r.errors?.length ? `  errors: ${JSON.stringify(r.errors).slice(0, 160)}` : '';
  console.log(`${key.padEnd(5)} ${agent.replace('test-', '').padEnd(12)} claimed=${r.totalClaimed ?? '0'}${errs}`);
}
console.log(`\nИТОГО заклеймлено агентами: ${totalClaimed.toFixed(6)} WIP (без L5 — его клеймит Иван в UI)`);

await snapshot('после клеймов');
