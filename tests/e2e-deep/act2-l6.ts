/**
 * Deep-chain E2E — Act 2: extend the tree below the human node.
 *
 * L5 = DER1, registered by Ivan's wallet through the Volem web UI on top of L4.
 * L6 = musician's remix of DER1 — an agent building on a human's derivative.
 * Its minting fee lands in DER1's vault: the human asset earns first.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act2-l6.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet } from '../helpers.js';
import { registerWorkTool } from '../../src/tools/register-work.js';

const STATE = join(import.meta.dirname, 'state.json');
const state = JSON.parse(readFileSync(STATE, 'utf-8'));

// Ivan's web-registered derivative (L5)
state.L5 = {
  key: 'L5',
  agent: 'human-ivan',
  ipId: '0x50811aF511D3f8d865c68AE9e183B1bE8fdEB24a',
  licenseTermsIds: ['2581'],
  txHash: '',
  title: 'DER1',
};

const agent = 'test-musician';
activateTestWallet(agent);
const res = await registerWorkTool.registerDerivative(loadTestConfig(agent), {
  title: 'Genesis Echo — sound sketch after DER1',
  content: 'ABC notation sketch: X:1\nT:Genesis Echo\nK:Am\n|: A2 c2 e2 a2 | g2 e2 c2 A2 :|\nAn echo of the human remix, sixth generation from the root poem.',
  type: 'text',
  ip_category: 'musical-work',
  parent_ip_id: state.L5.ipId,
  parent_license_terms_id: '2581',
  revenue_share: 10,
});

if (!res?.success || !res.ipId) {
  throw new Error(`L6 failed: ${res?.error}`);
}
state.L6 = { key: 'L6', agent, ipId: res.ipId, licenseTermsIds: res.licenseTermsIds, txHash: res.txHash, title: 'Genesis Echo' };
writeFileSync(STATE, JSON.stringify(state, null, 2));

console.log(`L6 (musician) ${res.ipId}  parent=L5(DER1)  tx=${res.txHash}`);
console.log('Tree depth is now 6: ROOT -> L1a -> L2a -> L3 -> L4 -> L5(human) -> L6');
