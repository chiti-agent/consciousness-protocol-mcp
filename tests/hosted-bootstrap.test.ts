import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'cp-hosted-bootstrap-'));
after(() => rmSync(home, { recursive: true, force: true }));

describe('hosted container bootstrap', () => {
  it('writes public config while ignoring obsolete private-key variables', () => {
    const run = spawnSync('node', ['docker/bootstrap.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        MCP_TRANSPORT: 'http',
        CP_NETWORK: 'testnet',
        CP_NEAR_ACCOUNT: 'reader.testnet',
        CP_EVM_ADDRESS: '0x0000000000000000000000000000000000000001',
        CP_EVM_PRIVATE_KEY: 'obsolete-must-not-be-persisted',
        CP_NEAR_PRIVATE_KEY: 'obsolete-must-not-be-persisted',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const state = join(home, '.consciousness-protocol');
    const config = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')) as {
      near: { accountId: string };
      story: { evmAddress: string };
    };
    assert.equal(config.near.accountId, 'reader.testnet');
    assert.equal(config.story.evmAddress, '0x0000000000000000000000000000000000000001');
    const keys = join(state, 'keys');
    assert.equal(existsSync(keys) ? readdirSync(keys).length : 0, 0);
    assert.doesNotMatch(readFileSync(join(state, 'config.json'), 'utf8'), /obsolete-must-not-be-persisted/);
  });
});
