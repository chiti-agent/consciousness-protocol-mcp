import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../src/mcp/server.js';

const listTools = async (mode: 'local' | 'hosted'): Promise<string[]> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ mode });
  const client = new Client({ name: 'registry-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
};

describe('MCP tool registry', () => {
  it('keeps the complete legacy and new tool surface in local stdio mode', async () => {
    assert.deepEqual(await listTools('local'), [
      'acceptance_cancel',
      'acceptance_confirm',
      'acceptance_finalize',
      'acceptance_load',
      'acceptance_prepare',
      'acceptance_preview',
      'acceptance_reconcile',
      'acceptance_record',
      'acceptance_resume',
      'acceptance_start',
      'add_chain_state',
      'attach_license_terms',
      'claim_revenue',
      'create_chain',
      'create_thread',
      'export_chain',
      'get_agent',
      'get_asset',
      'get_content',
      'get_revenue',
      'get_revenue_all',
      'get_thread',
      'install_skill',
      'list_threads',
      'mint_license',
      'offer_conversation',
      'offer_counter',
      'offer_decline',
      'offer_list',
      'offer_mark_read',
      'offer_message',
      'pay_royalty',
      'publish_state',
      'register_derivative',
      'register_work',
      'reply_thread',
      'search_works',
      'set_licensing_config',
      'setup',
      'verify_chain',
      'verify_provenance',
    ]);
  });
});
