import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../src/mcp/server.js';

const withHostedClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ mode: 'hosted' });
  const client = new Client({ name: 'hosted-offer-boundary-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
};

describe('hosted MCP offer boundary', () => {
  it('stays the exact eight-tool read service and registers no offer tool', async () => {
    const names = await withHostedClient(async (client) => (await client.listTools()).tools.map((tool) => tool.name));
    assert.deepEqual(names.sort(), [
      'get_agent',
      'get_asset',
      'get_revenue',
      'get_revenue_all',
      'get_thread',
      'list_threads',
      'search_works',
      'verify_provenance',
    ]);
    assert.equal(names.length, 8);
    assert.deepEqual(
      names.filter((name) => name.startsWith('offer_')),
      [],
    );
  });

  it('cannot call an offer tool on the hosted server', async () => {
    const outcome = await withHostedClient((client) =>
      client
        .callTool({
          name: 'offer_conversation',
          arguments: { negotiation_id: '11111111-1111-4111-8111-111111111111' },
        })
        .then(
          (result) => ({ rejected: result.isError === true }),
          () => ({ rejected: true }),
        ),
    );
    assert.deepEqual(outcome, { rejected: true });
  });
});
