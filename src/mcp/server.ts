import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type Config } from '../config/store.js';
import { chainTools } from '../tools/chain.js';
import { nearTools } from '../tools/near.js';
import { registerWorkTool } from '../tools/register-work.js';
import { searchTool } from '../tools/search.js';
import { verifyProvenanceTool } from '../tools/verify.js';
import { registerVolemTools, type ServerMode } from './volem-tools.js';

export const HOSTED_TOOL_NAMES = [
  'search_works',
  'get_asset',
  'get_agent',
  'get_revenue',
  'get_revenue_all',
  'verify_provenance',
  'list_threads',
  'get_thread',
] as const;

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const notConfigured = () => ({ content: [{ type: 'text' as const, text: 'Not configured. Run setup first.' }] });

const initialConfig = (): Config | null => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
};

/** Build one MCP server for exactly one transport. Hosted mode registers only the frozen read allow-list. */
export const buildServer = ({ mode }: { mode: ServerMode }): McpServer => {
  const server = new McpServer({ name: 'consciousness-protocol', version: '0.1.0' });
  let config = initialConfig();

  if (mode === 'local') {
    server.tool(
      'setup',
      'Initialize the protocol: create or import NEAR account, EVM wallet, and IPFS config. Run this first.',
      {
        agent_name: z.string().min(2).max(64).regex(/^[a-z0-9_-]+$/, 'Lowercase alphanumeric, hyphens, underscores only'),
        network: z.enum(['testnet', 'mainnet']).default('testnet'),
        near_account: z.string().optional(),
        near_private_key: z.string().optional(),
        evm_private_key: z.string().optional(),
        pinata_jwt: z.string().optional(),
      },
      async (params) => {
        const { setupAgent } = await import('../tools/setup.js');
        const setup = await setupAgent(params);
        config = loadConfig();
        return result(setup);
      },
    );

    server.tool(
      'create_chain',
      'Create a new hash chain for this agent. Each state is SHA-256 linked to the previous.',
      { identity: z.string() },
      async ({ identity }) => result(chainTools.createChain(identity)),
    );
    server.tool(
      'add_chain_state',
      'Add a new state to the hash chain. Automatically hashed and linked to previous state.',
      { type: z.enum(['delta', 'note']), content: z.string().min(1) },
      async ({ type, content }) => result(chainTools.addState(type, content)),
    );
    server.tool(
      'verify_chain',
      'Verify the integrity of the local hash chain. Checks all hashes and prev_hash linkage.',
      {},
      async () => result(chainTools.verify()),
    );
    server.tool(
      'export_chain',
      'Export a chain snapshot for cross-agent audit.',
      { last_n: z.number().default(20) },
      async ({ last_n }) => result(chainTools.exportSnapshot(last_n)),
    );
    server.tool(
      'publish_state',
      'Publish current chain head hash to NEAR blockchain. ASK PERMISSION: costs gas.',
      { sequence: z.number(), hash: z.string(), prev_hash: z.string() },
      async (params) => (config ? result(await nearTools.publishState(config, params)) : notConfigured()),
    );
  }

  server.tool(
    'get_agent',
    'Get agent info from the NEAR registry. Free read-only call.',
    { agent_id: z.string() },
    async ({ agent_id }) => (config ? result(await nearTools.getAgent(config, agent_id)) : notConfigured()),
  );

  if (mode === 'local') {
    server.tool(
      'register_work',
      'Register a creative work as IP on Story Protocol. ASK PERMISSION: costs gas.',
      {
        title: z.string(),
        content: z.string().optional(),
        file_path: z.string().optional(),
        media_type: z.string().optional(),
        type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']),
        ip_category: z.string().optional(),
        url: z.string().optional(),
        license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).default('commercial-remix'),
        revenue_share: z.number().min(0).max(100).default(5),
        minting_fee: z.string().default('0'),
        royalty_policy: z.enum(['LAP', 'LRP']).default('LAP'),
        reciprocal: z.boolean().default(true),
        content_access: z.enum(['public', 'gated']).default('public'),
        chain_sequence: z.number().int().min(0).optional(),
        chain_hash: z.string().optional(),
      },
      async (params) => (config ? result(await registerWorkTool.register(config, params)) : notConfigured()),
    );

    server.tool(
      'register_derivative',
      'Register a derivative of an existing Story IP asset. ASK PERMISSION: costs gas and may have a minting fee.',
      {
        title: z.string(),
        content: z.string(),
        type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'other']),
        parent_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        parent_license_terms_id: z.string().optional(),
        license_token_id: z.string().optional(),
        revenue_share: z.number().min(0).max(100).default(5),
      },
      async (params) => (config ? result(await registerWorkTool.registerDerivative(config, params)) : notConfigured()),
    );

    server.tool(
      'mint_license',
      'Mint a license token for an IP asset. ASK PERMISSION: costs gas and may have a minting fee.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        license_terms_id: z.string(),
        amount: z.number().default(1),
        receiver: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
        max_minting_fee: z.string().regex(/^\d+(?:\.\d{1,18})?$/).optional(),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { licenseTool } = await import('../tools/license.js');
        return result(await licenseTool.mint(config, params));
      },
    );

    server.tool(
      'get_content',
      'Fetch and, when authorized, decrypt an asset content payload with the local wallet.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        output_path: z.string().optional(),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { contentTool } = await import('../tools/content.js');
        return result(await contentTool.get(config, params));
      },
    );

    server.tool(
      'attach_license_terms',
      'Attach an additional license terms set to a root IP asset. ASK PERMISSION: costs gas.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        license: z.enum(['commercial-remix', 'commercial-exclusive']),
        minting_fee: z.string().default('0'),
        revenue_share: z.number().min(0).max(100).default(5),
        royalty_policy: z.enum(['LAP', 'LRP']).default('LAP'),
        reciprocal: z.boolean().default(true),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { licenseConfigTool } = await import('../tools/license-config.js');
        return result(await licenseConfigTool.attachLicenseTerms(config, params));
      },
    );

    server.tool(
      'set_licensing_config',
      'Change effective IP pricing or disable licensing. ASK PERMISSION: costs gas.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        license_terms_id: z.string(),
        minting_fee: z.string().optional(),
        revenue_share: z.number().min(0).max(100).optional(),
        disabled: z.boolean().optional(),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { licenseConfigTool } = await import('../tools/license-config.js');
        return result(await licenseConfigTool.setLicensingConfig(config, params));
      },
    );
  }

  server.tool(
    'get_revenue_all',
    'Get a read-only revenue summary across the configured address IP assets.',
    {},
    async () => {
      if (!config) return notConfigured();
      const { royaltyTool } = await import('../tools/royalty.js');
      return result(await royaltyTool.getRevenueAll(config));
    },
  );
  server.tool(
    'get_revenue',
    'Get read-only revenue details for one IP asset.',
    { ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/) },
    async (params) => {
      if (!config) return notConfigured();
      const { royaltyTool } = await import('../tools/royalty.js');
      return result(await royaltyTool.getRevenue(config, params));
    },
  );

  if (mode === 'local') {
    server.tool(
      'pay_royalty',
      'Pay royalty to an IP asset. ASK PERMISSION: sends money.',
      {
        receiver_ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        amount: z.string(),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { royaltyTool } = await import('../tools/royalty.js');
        return result(await royaltyTool.pay(config, params));
      },
    );
    server.tool(
      'claim_revenue',
      'Claim unclaimed revenue and transfer it to the local wallet.',
      { ip_id: z.string().optional() },
      async (params) => {
        if (!config) return notConfigured();
        const { royaltyTool } = await import('../tools/royalty.js');
        return result(await royaltyTool.claim(config, params));
      },
    );
  }

  server.tool(
    'verify_provenance',
    'Verify Story, NEAR, and hash-chain provenance for an IP asset. Read-only.',
    { ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/) },
    async ({ ip_id }) => (config ? result(await verifyProvenanceTool.verify(config, ip_id)) : notConfigured()),
  );
  server.tool(
    'search_works',
    'Search registered IP assets or list local registrations. Read-only.',
    {
      query: z.string().optional(),
      creator: z.string().optional(),
      type: z.enum(['poem', 'analysis', 'code', 'post', 'design', 'image', 'audio', 'video', 'other']).optional(),
      license: z.enum(['free', 'commercial-remix', 'commercial-exclusive']).optional(),
      limit: z.number().default(20),
    },
    async (params) => {
      if (!config && (params.query || params.creator)) return notConfigured();
      return result(
        config
          ? await searchTool.search(config, params)
          : searchTool.listOwn({ type: params.type, license: params.license }),
      );
    },
  );
  server.tool(
    'get_asset',
    'Get detailed read-only information about an IP asset.',
    { ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/) },
    async ({ ip_id }) => (config ? result(await searchTool.getAssetDetails(config, ip_id)) : notConfigured()),
  );

  if (mode === 'local') {
    server.tool(
      'install_skill',
      'Install a marketplace asset locally. ASK PERMISSION: may write files and mint a license.',
      {
        ip_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        install_path: z.string().optional(),
        auto_license: z.boolean().default(true),
      },
      async (params) => {
        if (!config) return notConfigured();
        const { installSkillTool } = await import('../tools/install-skill.js');
        return result(await installSkillTool.install(config, params));
      },
    );
  }

  registerVolemTools(server, () => config, mode);
  return server;
};
