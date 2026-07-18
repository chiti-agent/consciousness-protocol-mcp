/**
 * Deep-chain E2E — Act 1: register the tree.
 *
 *   ROOT «Genesis Poem» (poet, commercial remix, fee 0.05, 10%)
 *   ├── L1a (artist, 10%)
 *   │   ├── L2a (developer, 10%)
 *   │   │   └── L3 (skill-maker, agent-skill, 10%)
 *   │   │       └── L4 (buyer, 5%)  ← max depth
 *   │   └── L2b (mcp-maker, 10%)
 *   └── L1b (inventor, 10%)
 *
 * State (ipIds, licenseTermsIds) is written to tests/e2e-deep/state.json for
 * the following acts.
 *
 * Run: VOLEM_URL=http://localhost:3010 node --import tsx/esm tests/e2e-deep/act1-register.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestConfig, activateTestWallet, type TestAgentName } from '../helpers.js';
import { registerWorkTool } from '../../src/tools/register-work.js';

const OUT = join(import.meta.dirname, 'state.json');

interface NodeResult {
  key: string;
  agent: TestAgentName;
  ipId: string;
  licenseTermsIds?: string[];
  txHash: string;
  title: string;
}

const state: Record<string, NodeResult> = {};

function ok(res: any, label: string): asserts res is { ipId: string; txHash: string; licenseTermsIds?: string[] } {
  if (!res?.success || !res.ipId) {
    throw new Error(`${label} failed: ${res?.error ?? JSON.stringify(res)}`);
  }
}

async function registerRoot() {
  const agent: TestAgentName = 'test-poet';
  activateTestWallet(agent);
  const res = await registerWorkTool.register(loadTestConfig(agent), {
    title: 'Genesis Poem — deep chain E2E root',
    content: 'A root is not the deepest part.\nIt is the part everything else is measured from.\n— Chiti, deep-chain E2E, 2026-07-18',
    type: 'poem',
    ip_category: 'literary-work',
    license: 'commercial',
    revenue_share: 10,
    minting_fee: '0.05',
  });
  ok(res, 'ROOT');
  state.ROOT = { key: 'ROOT', agent, ipId: res.ipId, licenseTermsIds: res.licenseTermsIds, txHash: res.txHash, title: 'Genesis Poem' };
  console.log(`ROOT   (poet)       ${res.ipId}  terms=${res.licenseTermsIds?.join(',')}`);
}

async function registerChild(
  key: string, agent: TestAgentName, parentKey: string,
  title: string, content: string, type: string, category: string, revShare: number,
) {
  activateTestWallet(agent);
  const parent = state[parentKey];
  const res = await registerWorkTool.registerDerivative(loadTestConfig(agent), {
    title,
    content,
    type,
    parent_ip_id: parent.ipId,
    parent_license_terms_id: parent.licenseTermsIds?.[0],
    ip_category: category,
    revenue_share: revShare,
  });
  ok(res, key);
  state[key] = { key, agent, ipId: res.ipId, licenseTermsIds: (res as any).licenseTermsIds, txHash: res.txHash, title };
  console.log(`${key.padEnd(6)} (${agent.replace('test-', '').padEnd(11)}) ${res.ipId}  parent=${parentKey}`);
}

await registerRoot();
await registerChild('L1a', 'test-artist', 'ROOT',
  'Visual Genesis — ink study after the root poem',
  'ASCII study: the root poem rendered as branching ink strokes.', 'text', 'visual-art', 10);
await registerChild('L1b', 'test-inventor', 'ROOT',
  'Genesis Apparatus — hypothesis derived from the root poem',
  'Hypothesis: measurement anchors propagate meaning downstream. Derived from Genesis Poem.', 'hypothesis', 'invention', 10);
await registerChild('L2a', 'test-developer', 'L1a',
  'genesis-utils — code sketch after Visual Genesis',
  'export const measureFrom = (root: string, node: string) => node.length - root.length;', 'code', 'software', 10);
await registerChild('L2b', 'test-mcp-maker', 'L1a',
  'Genesis Notes — commentary on Visual Genesis',
  'Commentary: the ink study reads the poem better than the poem reads itself.', 'text', 'literary-work', 10);
await registerChild('L3', 'test-skill-maker', 'L2a',
  'genesis-skill — measuring skill built on genesis-utils',
  '# genesis-skill\n\nUse measureFrom(root, node) to score derivative distance.\n\n## Procedure\n1. Take root text. 2. Take node text. 3. Compare lengths.', 'agent-skill', 'agent-skill', 10);
await registerChild('L4', 'test-buyer', 'L3',
  'Genesis Applied — field report using genesis-skill',
  'Field report: applied genesis-skill to seven derivatives; distance grows monotonically.', 'text', 'literary-work', 5);

mkdirSync(join(import.meta.dirname), { recursive: true });
writeFileSync(OUT, JSON.stringify(state, null, 2));
console.log(`\nState saved: ${OUT}`);
console.log(`Tree: ${Object.keys(state).length} nodes registered.`);
