/**
 * Deep-chain E2E — Act 9: license-gated content, full cycle.
 *
 * 1. poet registers a GATED work (fee 0.02): content encrypted, key in Volem.
 * 2. buyer get_content without a license → 403 refusal.
 * 3. buyer mints a license (0.02 WIP) → get_content returns the decrypted
 *    plaintext with provenanceVerified=true.
 * 4. owner (poet) get_content works without any license.
 * 5. sanity: raw IPFS blob is NOT the plaintext; public API leaks no key.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act9-gated-content.ts
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, restoreOriginalWallet } from '../helpers.js';
import { registerWorkTool } from '../../src/tools/register-work.js';
import { licenseTool } from '../../src/tools/license.js';
import { contentTool } from '../../src/tools/content.js';

const STATE_FILE = join(import.meta.dirname, 'state-gated.json');
const state: Record<string, any> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const SECRET = [
  'СКРЫТЫЙ НАВЫК: Экономика роялти для агентов.',
  'Правило 1: LAP защищает корень — каждый предок берёт полный процент с любой глубины.',
  'Правило 2: LRP дружелюбен к глубоким цепочкам — платишь только прямому родителю.',
  'Правило 3: сначала проверь licensingConfig — эффективная цена важнее базовой.',
].join('\n');

// --- 1. Register gated work ---
if (!state.GATED) {
  console.log('1) poet регистрирует GATED работу (fee 0.02)...');
  activateTestWallet('test-poet');
  const reg = await registerWorkTool.register(loadTestConfig('test-poet'), {
    title: 'Hidden Royalty Playbook',
    content: SECRET,
    type: 'analysis',
    ip_category: 'agent-skill',
    license: 'commercial-remix',
    revenue_share: 10,
    minting_fee: '0.02',
    content_access: 'gated',
  }) as any;
  if (!reg.success) throw new Error(`register failed: ${reg.error}`);
  state.GATED = { ipId: reg.ipId, licenseTermsIds: reg.licenseTermsIds };
  save();
  console.log('   ipId:', reg.ipId, 'terms:', reg.licenseTermsIds, 'access:', reg.contentAccess);
}
const IP = state.GATED.ipId;

// --- 2+3. buyer: refusal without license, then mint and read ---
activateTestWallet('test-buyer');
const buyerCfg = loadTestConfig('test-buyer');

if (!state.GATED.buyerToken) {
  console.log('\n2) buyer без лицензии просит контент (ждём отказ)...');
  const denied = await contentTool.get(buyerCfg, { ip_id: IP }) as any;
  if (denied.success || !/license-gated|Access denied/i.test(denied.error ?? '')) {
    throw new Error(`ожидался отказ, получено: ${JSON.stringify(denied).slice(0, 300)}`);
  }
  console.log('   OK, отказ:', denied.error.slice(0, 90), '…');

  console.log('\n3) buyer минтит лицензию (0.02 WIP)...');
  const mint = await licenseTool.mint(buyerCfg, {
    ip_id: IP,
    license_terms_id: state.GATED.licenseTermsIds[0],
    amount: 1,
  }) as any;
  if (!mint.success) throw new Error(`mint failed: ${mint.error}`);
  state.GATED.buyerToken = mint.licenseTokenIds?.[0];
  save();
  console.log('   token:', state.GATED.buyerToken);
} else {
  console.log('\n2-3) buyer уже держит token', state.GATED.buyerToken, '(отказ проверен прошлым прогоном)');
}
console.log('   buyer читает с лицензией...');

const unlocked = await contentTool.get(buyerCfg, { ip_id: IP }) as any;
if (!unlocked.success) throw new Error(`get_content failed: ${unlocked.error}`);
if (unlocked.content !== SECRET) throw new Error('расшифрованный контент НЕ совпадает с оригиналом!');
if (unlocked.provenanceVerified !== true) throw new Error(`provenance не сошёлся: ${unlocked.provenanceVerified}`);
console.log('   OK: контент совпал, provenanceVerified=true, mediaType:', unlocked.mediaType);

// --- 4. owner reads without license ---
console.log('\n4) owner (poet) читает без лицензии...');
activateTestWallet('test-poet');
const ownerRead = await contentTool.get(loadTestConfig('test-poet'), { ip_id: IP }) as any;
if (!ownerRead.success || ownerRead.content !== SECRET) throw new Error(`owner read failed: ${ownerRead.error}`);
console.log('   OK');

// --- 5. sanity: blob on IPFS is ciphertext; public API has no key ---
console.log('\n5) sanity: IPFS-блоб зашифрован, публичный API без ключа...');
const volem = process.env.VOLEM_URL ?? 'http://localhost:3010';
const pub = await (await fetch(`${volem}/api/ip/${IP}`)).json() as any;
if (JSON.stringify(pub).includes('contentKey')) throw new Error('contentKey утёк в публичный API!');
const rawUrl: string = pub.mediaUrl ?? pub.asset?.mediaUrl;
const gatewayUrl = rawUrl.startsWith('ipfs://')
  ? 'https://gateway.pinata.cloud/ipfs/' + rawUrl.slice('ipfs://'.length)
  : rawUrl;
const blobRaw = await (await fetch(gatewayUrl)).arrayBuffer();
const blobText = Buffer.from(blobRaw).toString('utf-8');
if (blobText.includes('СКРЫТЫЙ НАВЫК')) throw new Error('IPFS-блоб содержит открытый текст!');
console.log(`   OK: blob ${blobRaw.byteLength}B — шифротекст; contentAccess=${pub.contentAccess ?? pub.asset?.contentAccess}`);

restoreOriginalWallet();
console.log('\nact9 done — gated контент работает конец-в-конец.');
