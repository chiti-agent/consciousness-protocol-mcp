#!/usr/bin/env node
/**
 * Consciousness Protocol MCP Server
 *
 * Provides AI agents with tools for:
 * - Hash chain management (create, add state, verify, export)
 * - NEAR blockchain (publish state, get agent info)
 * - Story Protocol IP (register work, derivatives, licensing, royalties)
 * - Provenance verification (cross-chain verification)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { registerWorkTool } from './tools/register-work.js';
import { nearTools } from './tools/near.js';
import { chainTools } from './tools/chain.js';
import { verifyProvenanceTool } from './tools/verify.js';
import { searchTool } from './tools/search.js';
import { loadConfig, type Config } from './config/store.js';

const server = new McpServer({
  name: 'consciousness-protocol',
  version: '0.1.0',
});

// Load config (or return null if not set up yet)
let config: Config | null = null;
try {
  config = loadConfig();
} catch {
  // Not configured yet — setup tool will handle this
}

// ─── Setup Tool ───

server.tool(
  'setup',
  'Initialize the protocol: create or import NEAR account, EVM wallet, and IPFS config. Run this first.',
  {
    agent_name: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/, 'Lowercase alphanumeric, hyphens, underscores only').describe('Agent name for NEAR account (e.g. "chiti")'),
    network: z.enum(['testnet', 'mainnet']).default('testnet').describe('NEAR/Story network'),
    near_account: z.string().optional().describe('Existing NEAR account ID (skip creation)'),
    near_private_key: z.string().optional().describe('Existing NEAR private key'),
    evm_private_key: z.string().optional().describe('Existing EVM private key for Story Protocol'),
    pinata_jwt: z.string().optional().describe('Pinata JWT for IPFS uploads (optional, free fallback available)'),
  },
  async (params) => {
    const { setupAgent } = await import('./tools/setup.js');
    const result = await setupAgent(params);
    config = loadConfig(); // reload after setup
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Chain Tools ───

server.tool(
  'create_chain',
  'Create a new hash chain for this agent. Each state is SHA-256 linked to the previous.',
  { identity: z.string().describe('Chain identity (e.g. "my-agent")') },
  async (params) => {
    const result = chainTools.createChain(params.identity);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'add_chain_state',
  'Add a new state to the hash chain. Automatically hashed and linked to previous state.',
  {
    type: z.enum(['delta', 'note']).describe('State type: delta (change) or note (observation)'),
    content: z.string().min(1).describe('Content to record'),
  },
  async (params) => {
    const result = chainTools.addState(params.type, params.content);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'verify_chain',
  'Verify the integrity of the local hash chain. Checks all hashes and prev_hash linkage.',
  {},
  async () => {
    const result = chainTools.verify();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'export_chain',
  'Export a chain snapshot for cross-agent audit. Returns last N states with verification instructions.',
  { last_n: z.number().default(20).describe('Number of recent states to export') },
  async (params) => {
    const result = chainTools.exportSnapshot(params.last_n);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── NEAR Tools ───

server.tool(
  'publish_state',
  'Publish current chain head hash to NEAR blockchain. Contract verifies prev_hash (fork detection). Gas: ~$0.003.',
  {
    sequence: z.number().describe('Chain state sequence number'),
    hash: z.string().describe('SHA-256 hex hash of current state'),
    prev_hash: z.string().describe('SHA-256 hex hash of previous state'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await nearTools.publishState(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_agent',
  'Get agent info from NEAR registry (identity, model, trust score, last published state). Free view call.',
  { agent_id: z.string().describe('NEAR account ID of the agent') },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await nearTools.getAgent(config, params.agent_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── IP Tools ───

server.tool(
  'register_work',
  'Register a creative work as IP on Story Protocol with blockchain provenance. Uploads to IPFS, mints NFT, attaches license. ASK PERMISSION: costs gas (~$0.15).',
  {
    title: z.string().describe('Title of the work'),
    content: z.string().optional().describe('Text content of the work (for text-based works)'),
    file_path: z.string().optional().describe('Path to file — image, audio, video, code, etc.'),
    media_type: z.string().optional().describe('MIME type override (e.g. "image/png", "audio/mp3"). Auto-detected from file extension if omitted.'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']).describe('Type of work'),
    license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).default('commercial-remix').describe('License type'),
    revenue_share: z.number().min(0).max(100).default(5).describe('Revenue share % for derivatives (default: 5)'),
    minting_fee: z.string().default('0').describe('Price to mint a license in IP tokens (e.g. "0.01"). Default: free.'),
    chain_sequence: z.number().int().min(0).optional().describe('Chain state sequence (for provenance)'),
    chain_hash: z.string().optional().describe('Chain state hash (for provenance)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await registerWorkTool.register(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'register_derivative',
  'Register a derivative work of an existing IP. Revenue share automatically flows to parent. ASK PERMISSION: costs gas + possible minting fee.',
  {
    title: z.string().describe('Title of derivative work'),
    content: z.string().describe('Full text content'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'other']).describe('Type'),
    parent_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address (0x + 40 hex chars)').describe('IP Asset ID of parent work (0x...)'),
    parent_license_terms_id: z.string().describe('License terms ID from parent'),
    license_token_id: z.string().optional().describe('If using pre-minted license token (burns it)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await registerWorkTool.registerDerivative(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mint_license',
  'Mint a license token for an IP Asset. Gives right to use the work or create derivatives. ASK PERMISSION: may have minting fee.',
  {
    ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to license (0x...)'),
    license_terms_id: z.string().describe('License terms ID'),
    amount: z.number().default(1).describe('Number of license tokens to mint'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { licenseTool } = await import('./tools/license.js');
    const result = await licenseTool.mint(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'pay_royalty',
  'Pay royalty to an IP Asset. Auto-wraps native IP to WIP. ASK PERMISSION: sends money.',
  {
    receiver_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset to pay (0x...)'),
    amount: z.string().describe('Amount in IP tokens (e.g. "0.01")'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.pay(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'claim_revenue',
  'Claim all unclaimed revenue from your IP Assets. Automatically transfers to your wallet. No permission needed — money comes in, not out.',
  {
    ip_id: z.string().optional().describe('Specific IP to claim from (default: all own IPs)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const { royaltyTool } = await import('./tools/royalty.js');
    const result = await royaltyTool.claim(config, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'verify_provenance',
  'Verify provenance of any IP Asset. Checks Story Protocol metadata → NEAR state → chain integrity. Free, read-only.',
  { ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to verify (0x...)') },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await verifyProvenanceTool.verify(config, params.ip_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Search & Browse Tools ───

server.tool(
  'search_works',
  'Search registered IP assets. Without parameters: lists own works. With query: semantic search. With creator: by address. Backend: volem (default), story (direct API), local. Free, read-only.',
  {
    query: z.string().optional().describe('Search query (semantic search across all assets)'),
    creator: z.string().optional().describe('EVM address of creator to search for'),
    type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']).optional().describe('Filter by work type'),
    license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).optional().describe('Filter by license type'),
    limit: z.number().default(20).describe('Max results (default: 20)'),
  },
  async (params) => {
    if (!config && (params.query || params.creator)) {
      return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    }
    const result = config
      ? await searchTool.search(config, params)
      : searchTool.listOwn({ type: params.type, license: params.license });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_asset',
  'Get detailed info about a specific IP asset: metadata, license, provenance, IPFS content. Free, read-only.',
  {
    ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid Ethereum address').describe('IP Asset ID to inspect (0x...)'),
  },
  async (params) => {
    if (!config) return { content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] };
    const result = await searchTool.getAssetDetails(config, params.ip_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ─── Start Server ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
