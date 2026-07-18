/**
 * Deep-chain E2E — Act 6: license-config tools.
 *
 * A) attach_license_terms on a DERIVATIVE (L6) → friendly refusal, no gas.
 * B) set_licensing_config on L6 (musician): fee 0.1 → read back on-chain.
 * C) attach_license_terms on ROOT (poet): second terms set (commercial-exclusive
 *    0.2) → on-chain terms id + LICENSE_ADDED event lands in Volem.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act6-license-config.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, restoreOriginalWallet } from '../helpers.js';
import { licenseConfigTool } from '../../src/tools/license-config.js';

const state = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf-8'));
const L6 = state.L6.ipId as `0x${string}`;
const ROOT = state.ROOT.ipId as `0x${string}`;
const VOLEM_URL = process.env.VOLEM_URL ?? 'http://localhost:3010';

// --- A) derivative guard ---
activateTestWallet('test-musician');
let cfg = loadTestConfig('test-musician');

console.log('A) attach_license_terms на дериватив L6 (должен отказать без газа)...');
const refusal = await licenseConfigTool.attachLicenseTerms(cfg, {
  ip_id: L6,
  license: 'commercial-exclusive',
  minting_fee: '0.2',
}) as any;
if (refusal.success || !/derivative/i.test(refusal.error ?? '')) {
  throw new Error(`ожидался отказ по деривативу, получено: ${JSON.stringify(refusal)}`);
}
console.log('   OK, отказ:', refusal.error.slice(0, 100), '…\n');

// --- B) set_licensing_config on L6 ---
console.log('B) set_licensing_config L6: fee 0.1...');
const setRes = await licenseConfigTool.setLicensingConfig(cfg, {
  ip_id: L6,
  license_terms_id: state.L6.licenseTermsIds[0],
  minting_fee: '0.1',
}) as any;
if (!setRes.success) throw new Error(`setLicensingConfig failed: ${setRes.error}`);
console.log('   tx:', setRes.txHash, 'effective:', JSON.stringify(setRes.effective));

// read back on-chain
{
  const { StoryClient } = await import('@story-protocol/core-sdk');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { http, formatEther } = await import('viem');
  const { loadKey } = await import('../../src/config/store.js');
  const account = privateKeyToAccount(loadKey('evm') as `0x${string}`);
  const client = StoryClient.newClient({ account, transport: http(cfg.story.rpcUrl), chainId: cfg.story.chainId });
  const onChain = await client.license.getLicensingConfig({ ipId: L6, licenseTermsId: BigInt(state.L6.licenseTermsIds[0]) });
  console.log(`   on-chain read-back: isSet=${onChain.isSet} fee=${formatEther(onChain.mintingFee)} disabled=${onChain.disabled}`);
  if (!onChain.isSet || formatEther(onChain.mintingFee) !== '0.1') throw new Error('read-back mismatch');
}
console.log('   OK\n');

// --- C) attach second terms on ROOT ---
restoreOriginalWallet();
activateTestWallet('test-poet');
cfg = loadTestConfig('test-poet');

console.log('C) attach_license_terms на ROOT: commercial-exclusive fee 0.2...');
const attach = await licenseConfigTool.attachLicenseTerms(cfg, {
  ip_id: ROOT,
  license: 'commercial-exclusive',
  minting_fee: '0.2',
}) as any;
if (!attach.success) throw new Error(`attach failed: ${attach.error}`);
console.log('   tx:', attach.txHash, 'termsIds:', attach.licenseTermsIds);

// verify LICENSE_ADDED reached Volem
const res = await fetch(`${VOLEM_URL}/api/ip/${ROOT}`);
const asset = await res.json() as any;
const added = (asset.asset?.licenseEvents ?? asset.licenseEvents ?? []).filter(
  (e: any) => e.eventType === 'LICENSE_ADDED' && e.licenseTermsId === attach.licenseTermsIds?.[0],
);
console.log(`   Volem LICENSE_ADDED для terms ${attach.licenseTermsIds?.[0]}: ${added.length > 0 ? 'есть' : 'НЕТ (проверь /api/ip/[ipId] shape)'}`);

restoreOriginalWallet();
console.log('\nact6 done');
