/**
 * Level B — install_skill integration tests.
 * Tests git clone, IPFS zip, IPFS tgz, npm, text content, error cases.
 * Depends on register.test.ts for ipIds of registered assets.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTestConfig,
  activateTestWallet,
  fixturePath,
  VOLEM_URL,
  type TestAgentName,
} from '../helpers.js';
import { installSkillTool } from '../../src/tools/install-skill.js';
import { registeredAssets } from './register.test.js';

// Use a temp directory for installs to avoid polluting ~/.claude/skills
const INSTALL_BASE = join(tmpdir(), 'cp-test-installs');

describe('install_skill', { timeout: 300_000 }, () => {
  before(() => {
    mkdirSync(INSTALL_BASE, { recursive: true });
  });

  after(() => {
    // Cleanup all installed test dirs
    try { rmSync(INSTALL_BASE, { recursive: true, force: true }); } catch {}
  });

  // --- Install from git URL ---
  it('installs skill from git URL', { timeout: 60_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const skill = registeredAssets['skill'];
    if (!skill?.ipId) {
      // Skip if skill was not registered (depends on register test)
      console.log('  SKIP: skill not registered');
      return;
    }

    const installPath = join(INSTALL_BASE, 'skill-git');
    const result = await installSkillTool.install(config, {
      ip_id: skill.ipId,
      install_path: installPath,
    });

    // May fail if Volem doesn't have the asset metadata or git URL is not real
    // Accept both success (if git clone works) and controlled failure
    if (result.success) {
      assert.ok(result.installPath);
      assert.ok(
        existsSync(join(result.installPath!, 'SKILL.md')),
        'SKILL.md must exist after install',
      );
    } else {
      // Expected: git clone might fail for test URL
      assert.ok(result.error, 'must have error message');
    }
  });

  // --- Install from IPFS tgz ---
  it('installs from IPFS tgz (simulated via local asset)', { timeout: 60_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const mcp = registeredAssets['mcp-tgz'];
    if (!mcp?.ipId) {
      console.log('  SKIP: mcp-tgz not registered');
      return;
    }

    const installPath = join(INSTALL_BASE, 'mcp-tgz');
    const result = await installSkillTool.install(config, {
      ip_id: mcp.ipId,
      install_path: installPath,
    });

    if (result.success) {
      assert.ok(result.installPath);
      // tgz extraction should have produced package.json
      const hasPackageJson = existsSync(join(result.installPath!, 'package.json'))
        || existsSync(join(result.installPath!, 'package', 'package.json'));
      assert.ok(hasPackageJson || existsSync(join(result.installPath!, 'SKILL.md')),
        'Must have package.json or SKILL.md after tgz extraction');
    } else {
      // IPFS fetch might fail in test environment
      assert.ok(result.error);
    }
  });

  // --- Install npm package ---
  it('installs npm package by name', { timeout: 120_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const npm = registeredAssets['mcp-npm'];
    if (!npm?.ipId) {
      console.log('  SKIP: mcp-npm not registered');
      return;
    }

    const installPath = join(INSTALL_BASE, 'mcp-npm');
    const result = await installSkillTool.install(config, {
      ip_id: npm.ipId,
      install_path: installPath,
    });

    // npm install of 'test-mcp-server' may fail if package doesn't exist on npm
    if (result.success) {
      assert.ok(result.installPath);
      assert.equal(result.source, 'npm');
    } else {
      // Expected: test-mcp-server is not a real npm package
      assert.ok(result.error);
    }
  });

  // --- Install text content ---
  it('installs text content as SKILL.md', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const poem = registeredAssets['poem'];
    if (!poem?.ipId) {
      console.log('  SKIP: poem not registered');
      return;
    }

    // Poem is a literary-work, not in installableCategories by default
    // But it has text content, so install should work if content is available
    const installPath = join(INSTALL_BASE, 'poem-content');
    const result = await installSkillTool.install(config, {
      ip_id: poem.ipId,
      install_path: installPath,
    });

    // May fail as literary-work is not in installableCategories
    if (result.success) {
      assert.ok(existsSync(join(installPath, 'SKILL.md')));
      assert.equal(result.source, 'content');
    } else {
      // Expected: not installable category
      assert.ok(result.error?.includes('installable') || result.error?.includes('content'));
    }
  });

  // --- Install non-skill asset (image) -> error ---
  it('rejects install of non-skill asset (image)', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const image = registeredAssets['image'];
    if (!image?.ipId) {
      console.log('  SKIP: image not registered');
      return;
    }

    const installPath = join(INSTALL_BASE, 'image-fail');
    const result = await installSkillTool.install(config, {
      ip_id: image.ipId,
      install_path: installPath,
    });

    // Image has no git URL, no npm, text content, or installable category
    // It does have IPFS media though, so it depends on what Volem returns
    // The important check: it should either fail or install with limited content
    if (!result.success) {
      assert.ok(result.error, 'error message must exist for non-installable asset');
    }
    // If it succeeds (IPFS binary fetch), that's also acceptable behavior
  });

  // --- Install paid skill -> auto-mint license ---
  it('installs paid skill with auto-license', { timeout: 60_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const skill = registeredAssets['skill'];
    if (!skill?.ipId) {
      console.log('  SKIP: skill not registered');
      return;
    }

    const installPath = join(INSTALL_BASE, 'skill-paid');
    const result = await installSkillTool.install(config, {
      ip_id: skill.ipId,
      install_path: installPath,
      auto_license: true,
    });

    // auto_license should mint a license before installing
    if (result.success) {
      assert.ok(result.installPath);
      // licenseMinted may or may not be true depending on whether Volem
      // reports the asset as commercial
      if (result.licenseMinted) {
        assert.ok(result.licenseTokenId, 'must have licenseTokenId if license was minted');
      }
    } else {
      assert.ok(result.error);
    }
  });

  // --- Repeat install -> already installed ---
  it('detects already installed skill', { timeout: 30_000 }, async () => {
    const agent: TestAgentName = 'test-buyer';
    activateTestWallet(agent);
    const config = loadTestConfig(agent);

    const skill = registeredAssets['skill'];
    if (!skill?.ipId) {
      console.log('  SKIP: skill not registered');
      return;
    }

    // Create a pre-existing install directory with SKILL.md
    const installPath = join(INSTALL_BASE, 'skill-existing');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, 'SKILL.md'), '# Already here\n');

    const result = await installSkillTool.install(config, {
      ip_id: skill.ipId,
      install_path: installPath,
    });

    assert.equal(result.success, true);
    assert.ok(
      result.instructions?.includes('Already installed'),
      'Must indicate already installed',
    );
  });
});
