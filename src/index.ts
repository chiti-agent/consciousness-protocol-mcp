#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { assertHostedKeyless } from './config/store.js';
import { startHostedHttpServer } from './mcp/http-server.js';
import { buildServer } from './mcp/server.js';

const useHttp = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

const main = async (): Promise<void> => {
  if (useHttp) {
    assertHostedKeyless();
    await startHostedHttpServer();
    return;
  }

  const server = buildServer({ mode: 'local' });
  await server.connect(new StdioServerTransport());
};

main().catch((error) => {
  console.error('MCP server error:', error);
  process.exit(1);
});
