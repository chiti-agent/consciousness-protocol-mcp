/**
 * Deep-chain E2E — Act 7: LRP (Liquid Relative Percentage) tree economics.
 *
 * Builds a fresh 3-node chain on LRP 10% reciprocal, free minting:
 *   LRP-ROOT (poet) → LRP-L1 (artist) → LRP-L2 (musician)
 * then developer pays 0.09 WIP royalty on LRP-L2 and every node claims.
 *
 * Expected split (LRP: each node pays only its DIRECT parent 10%):
 *   L2 keeps 90%          = 0.081
 *   L1 gets 10% of 0.09   = 0.009, passes 10% of that upstream on claim
 *   ROOT gets 10% of L1's = 0.0009 (1% of the payment — vs 10% under LAP)
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act7-lrp.ts
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, restoreOriginalWallet, type TestAgentName } from '../helpers.js';
import { registerWorkTool } from '../../src/tools/register-work.js';
import { royaltyTool } from '../../src/tools/royalty.js';

const STATE_FILE = join(import.meta.dirname, 'state-lrp.json');
const state: Record<string, { ipId: string; agent: string; licenseTermsIds?: string[] }> =
  existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : {};

const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const asCfg = (agent: TestAgentName) => {
  activateTestWallet(agent);
  return loadTestConfig(agent);
};

// --- 1. Register the LRP root (skip if already there from a previous run) ---
if (!state.ROOT) {
  console.log('1) poet регистрирует LRP-ROOT (commercial-remix 10%, fee 0, LRP, reciprocal)...');
  const root = await registerWorkTool.register(asCfg('test-poet'), {
    title: 'Relative Genesis — LRP root poem',
    content: 'A poem that trusts its children: each derivative answers only to its direct parent.',
    type: 'poem',
    ip_category: 'literary-work',
    license: 'commercial-remix',
    revenue_share: 10,
    minting_fee: '0',
    royalty_policy: 'LRP',
    reciprocal: true,
  }) as any;
  if (!root.success) throw new Error(`root register failed: ${root.error}`);
  state.ROOT = { ipId: root.ipId, agent: 'test-poet', licenseTermsIds: root.licenseTermsIds };
  save();
  console.log('   ROOT:', root.ipId, 'terms:', root.licenseTermsIds);
}

// --- 2. L1 derivative ---
if (!state.L1) {
  console.log('2) artist делает LRP-L1 (дериватив ROOT)...');
  const l1 = await registerWorkTool.registerDerivative(asCfg('test-artist'), {
    title: 'Relative Visual — ink study after the LRP root',
    content: 'An ink study that pays its respects — and its royalties — to its direct parent only.',
    type: 'design',
    parent_ip_id: state.ROOT.ipId,
  }) as any;
  if (!l1.success) throw new Error(`L1 register failed: ${l1.error}`);
  state.L1 = { ipId: l1.ipId, agent: 'test-artist' };
  save();
  console.log('   L1:', l1.ipId);
}

// --- 3. L2 derivative ---
if (!state.L2) {
  console.log('3) musician делает LRP-L2 (дериватив L1)...');
  const l2 = await registerWorkTool.registerDerivative(asCfg('test-musician'), {
    title: 'Relative Echo — song after the LRP visual',
    content: 'A song two steps from the root: the root hears only an echo of an echo.',
    type: 'audio',
    parent_ip_id: state.L1.ipId,
  }) as any;
  if (!l2.success) throw new Error(`L2 register failed: ${l2.error}`);
  state.L2 = { ipId: l2.ipId, agent: 'test-musician' };
  save();
  console.log('   L2:', l2.ipId);
}

const snapshot = async (label: string) => {
  console.log(`\n=== claimable по узлам (${label}) ===`);
  const cfg = asCfg('test-poet'); // read-only
  for (const key of ['ROOT', 'L1', 'L2'] as const) {
    const rev = await royaltyTool.getRevenue(cfg, { ip_id: state[key].ipId }) as any;
    console.log(`${key.padEnd(5)} ${state[key].agent.padEnd(14)} claimableNow=${rev.claimableNow} totalEarned=${rev.totalEarned}`);
  }
};

// --- 4. Payment on the deepest node ---
console.log('\n4) developer платит 0.09 WIP роялти на LRP-L2...');
const pay = await royaltyTool.pay(asCfg('test-developer'), {
  receiver_ip_id: state.L2.ipId,
  amount: '0.09',
}) as any;
if (!pay.success) throw new Error(`pay failed: ${pay.error}`);
console.log('   payment tx:', pay.txHash);

await snapshot('после платежа, до клеймов');

// --- 5. Claims bottom-up ---
console.log('\n=== клеймы (снизу вверх) ===');
const CLAIM_ORDER: Array<['ROOT' | 'L1' | 'L2', TestAgentName]> = [
  ['L2', 'test-musician'],
  ['L1', 'test-artist'],
  ['ROOT', 'test-poet'],
];
for (const [key, agent] of CLAIM_ORDER) {
  const res = await royaltyTool.claim(asCfg(agent), { ip_id: state[key].ipId }) as any;
  console.log(`${key.padEnd(5)} claimed=${res.totalClaimed}${res.errors ? ' errors=' + JSON.stringify(res.errors) : ''}`);
}

await snapshot('после клеймов');

restoreOriginalWallet();
console.log('\nact7 done. Ожидание LRP: L2≈0.081, L1≈0.009→(минус 10% вверх), ROOT≈0.0009.');
