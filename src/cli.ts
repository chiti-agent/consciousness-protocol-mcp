#!/usr/bin/env node
/**
 * CLI entry point for interactive setup and utilities.
 *
 * Usage:
 *   consciousness-protocol setup    — interactive setup wizard
 *   consciousness-protocol balance  — check wallet balances
 *   consciousness-protocol status   — show config and registered IPs
 */

const command = process.argv[2];

if (!command || command === 'help' || command === '--help') {
  console.log(`
Consciousness Protocol CLI

Commands:
  setup     Interactive setup wizard (NEAR account + EVM wallet + IPFS)
  balance   Check NEAR and Story Protocol wallet balances
  status    Show configuration and registered IPs
  serve     Start MCP server (usually called by claude mcp add)

Usage with Claude Code:
  claude mcp add consciousness-protocol npx consciousness-protocol-mcp
`);
  process.exit(0);
}

if (command === 'serve') {
  // Start MCP server
  import('./index.js');
} else if (command === 'setup') {
  // Interactive setup (TODO: implement with inquirer)
  console.log('Interactive setup coming soon. Use MCP tool "setup" for now.');
} else if (command === 'balance') {
  console.log('Balance check coming soon.');
} else if (command === 'status') {
  import('./config/store.js').then(async ({ loadConfig, REGISTRATIONS_FILE }) => {
    const { existsSync, readFileSync } = await import('node:fs');
    try {
      const config = loadConfig();
      console.log('Configuration:', JSON.stringify(config, null, 2));

      if (existsSync(REGISTRATIONS_FILE)) {
        const regs = JSON.parse(readFileSync(REGISTRATIONS_FILE, 'utf-8'));
        console.log(`\nRegistered IPs: ${regs.length}`);
        for (const r of regs) {
          console.log(`  - ${r.title || 'untitled'}: ${r.ipId}`);
        }
      }
    } catch (err: any) {
      console.log('Not configured. Run: consciousness-protocol setup');
    }
  });
} else {
  console.error(`Unknown command: ${command}. Run --help for usage.`);
  process.exit(1);
}
