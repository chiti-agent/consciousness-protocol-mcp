/**
 * Deep-chain E2E — Act 5: buyer mints a license token on DER1 (Ivan's node)
 * at Ivan's configured price (setLicensingConfig fee overrides the inherited
 * terms fee). No new derivative — pure sale of usage rights.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act5-license.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet } from '../helpers.js';
import { licenseTool } from '../../src/tools/license.js';
import { royaltyTool } from '../../src/tools/royalty.js';

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));
const DER1 = state.L5.ipId;

activateTestWallet('test-buyer');
const cfg = loadTestConfig('test-buyer');

console.log('buyer минтит 1 license token на DER1 по цене владельца...');
const res = await licenseTool.mint(cfg, {
  ip_id: DER1,
  license_terms_id: '2581',
  amount: 1,
}) as any;

if (!res.success) throw new Error(`mint failed: ${res.error}`);
console.log('minted:', JSON.stringify(res, null, 2));

const rev = await royaltyTool.getRevenue(cfg, { ip_id: DER1 }) as any;
console.log(`\nDER1 после продажи лицензии: claimableNow=${rev.claimableNow}`);
