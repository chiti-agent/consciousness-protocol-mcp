/**
 * Level B — register_work integration tests (Story testnet).
 * 9 asset types, each with a different wallet.
 * Timeout: 30s per test (on-chain tx).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  loadTestConfig,
  activateTestWallet,
  fixturePath,
  readFixture,
  type TestAgentName,
} from '../helpers.js';
import { readFileSync } from 'node:fs';
import { registerWorkTool } from '../../src/tools/register-work.js';

// Shared state: ipIds stored for downstream tests (derivative, license, install)
export const registeredAssets: Record<string, {
  ipId: string;
  contentHash: string;
  licenseTermsIds?: string[];
  agent: TestAgentName;
}> = {};

describe('register_work — 9 asset types', { timeout: 600_000 }, () => {
  // --- 1. Text poem (poet, free) ---
  it('registers text poem', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-poet';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const content = readFixture('test-poem.txt');

    const result = await registerWorkTool.register(config, {
      title: 'Ode to Decentralization',
      content,
      type: 'poem',
      ip_category: 'literary-work',
      license: 'free',
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-1').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId, 'ipId must exist');
    assert.equal(
      result.contentHash,
      createHash('sha256').update(content).digest('hex'),
      'contentHash must match SHA256 of content',
    );

    registeredAssets['poem'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 2. TypeScript file (developer, commercial-remix 5%) ---
  it('registers .ts code file', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-developer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const filePath = fixturePath('test-code.ts');
    const fileBuffer = readFileSync(filePath);

    const result = await registerWorkTool.register(config, {
      title: 'validator-utils.ts',
      file_path: filePath,
      type: 'code',
      ip_category: 'software',
      license: 'commercial-remix',
      revenue_share: 5,
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-2').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);
    assert.equal(
      result.contentHash,
      createHash('sha256').update(fileBuffer).digest('hex'),
    );

    registeredAssets['code'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 3. Claude skill via git URL (skill-maker, commercial-remix 10% + 0.01 WIP fee) ---
  it('registers skill with git URL', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-skill-maker';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    // Use the skill fixture content as text (since we cannot git clone in test)
    const content = readFixture('test-skill/SKILL.md');

    const result = await registerWorkTool.register(config, {
      title: 'test-validator-skill',
      content,
      type: 'code',
      ip_category: 'agent-skill',
      url: 'https://github.com/chiti-agent/test-skill',
      license: 'commercial-remix',
      revenue_share: 10,
      minting_fee: '0.01',
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-3').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['skill'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 4. MCP server .tgz (mcp-maker, commercial-remix) ---
  it('registers MCP server from tgz', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-mcp-maker';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const filePath = fixturePath('test-mcp-server-0.1.0.tgz');

    const result = await registerWorkTool.register(config, {
      title: 'test-mcp-server',
      file_path: filePath,
      type: 'code',
      ip_category: 'mcp-server',
      license: 'commercial-remix',
      revenue_share: 5,
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-4').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['mcp-tgz'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 5. PNG image (artist, commercial-remix 15%) ---
  it('registers PNG image', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-artist';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const filePath = fixturePath('test-image.png');

    const result = await registerWorkTool.register(config, {
      title: 'abstract-chain.png',
      file_path: filePath,
      media_type: 'image/png',
      type: 'image',
      ip_category: 'visual-art',
      license: 'commercial-remix',
      revenue_share: 15,
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-5').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['image'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 6. MP3 audio (musician, free) ---
  it('registers MP3 audio', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-musician';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const filePath = fixturePath('test-audio.mp3');

    const result = await registerWorkTool.register(config, {
      title: 'ambient-blocks.mp3',
      file_path: filePath,
      media_type: 'audio/mpeg',
      type: 'audio',
      ip_category: 'audio-composition',
      license: 'free',
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-6').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['audio'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 7. Hypothesis text (poet wallet reused, free) ---
  it('registers hypothesis text', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-poet';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const content = readFixture('test-hypothesis.txt');

    const result = await registerWorkTool.register(config, {
      title: 'Distributed Consciousness Verification',
      content,
      type: 'analysis',
      ip_category: 'hypothesis',
      license: 'free',
      chain_sequence: 2,
      chain_hash: createHash('sha256').update('test-chain-7').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['hypothesis'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 8. PDF patent (inventor, commercial-exclusive + 0.05 WIP fee) ---
  it('registers PDF patent', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-inventor';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);
    const filePath = fixturePath('test-patent.pdf');

    const result = await registerWorkTool.register(config, {
      title: 'consensus-method.pdf',
      file_path: filePath,
      media_type: 'application/pdf',
      type: 'patent',
      ip_category: 'invention',
      license: 'commercial-exclusive',
      minting_fee: '0.05',
      chain_sequence: 1,
      chain_hash: createHash('sha256').update('test-chain-8').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['patent'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });

  // --- 9. npm MCP server (mcp-maker reused, free, url-based) ---
  it('registers npm MCP server by URL', { timeout: 90_000 }, async () => {
    const agent: TestAgentName = 'test-mcp-maker';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    // Register with npm URL as external reference
    const content = 'MCP server available via npm: test-mcp-server';

    const result = await registerWorkTool.register(config, {
      title: 'test-mcp-server-npm',
      content,
      type: 'code',
      ip_category: 'mcp-server',
      url: 'https://www.npmjs.com/package/test-mcp-server',
      license: 'free',
      chain_sequence: 2,
      chain_hash: createHash('sha256').update('test-chain-9').digest('hex'),
    });

    assert.equal(result.success, true, `Register failed: ${result.error}`);
    assert.ok(result.ipId);

    registeredAssets['mcp-npm'] = {
      ipId: result.ipId!,
      contentHash: result.contentHash!,
      licenseTermsIds: result.licenseTermsIds,
      agent,
    };
  });
});
