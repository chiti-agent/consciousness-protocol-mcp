/**
 * Fund test wallets on Story Aeneid testnet.
 * Strategy: try faucet first, fallback to transfer from main wallet.
 *
 * Run: node --import tsx/esm tests/wallets/fund-wallets.ts
 */

import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { generateWallets, type TestWallet } from './generate-wallets.js';

// Story Aeneid testnet
const AENEID_RPC = 'https://aeneid.storyrpc.io';
const AENEID_CHAIN_ID = 1315;
const FAUCET_URL = 'https://faucet.story.foundation/api/faucet';

const MIN_BALANCE = parseEther('0.1'); // Minimum needed per wallet
const FUND_AMOUNT = parseEther('0.3'); // Amount to send per wallet (enough for minting fees)

const storyAeneid = {
  id: AENEID_CHAIN_ID,
  name: 'Story Aeneid',
  nativeCurrency: { name: 'WIP', symbol: 'WIP', decimals: 18 },
  rpcUrls: { default: { http: [AENEID_RPC] } },
} as const;

const publicClient = createPublicClient({
  chain: storyAeneid,
  transport: http(AENEID_RPC),
});

async function getBalance(address: string): Promise<bigint> {
  return publicClient.getBalance({ address: address as `0x${string}` });
}

async function tryFaucet(address: string): Promise<boolean> {
  try {
    const res = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`    Faucet success: ${JSON.stringify(data)}`);
      return true;
    }

    console.log(`    Faucet returned ${res.status}: ${await res.text()}`);
    return false;
  } catch (err) {
    console.log(`    Faucet error: ${(err as Error).message}`);
    return false;
  }
}

async function transferFromMain(to: string, mainKey: string): Promise<boolean> {
  try {
    const account = privateKeyToAccount(mainKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: storyAeneid,
      transport: http(AENEID_RPC),
    });

    const hash = await walletClient.sendTransaction({
      to: to as `0x${string}`,
      value: FUND_AMOUNT,
    });

    console.log(`    Transfer tx: ${hash}`);
    return true;
  } catch (err) {
    console.log(`    Transfer failed: ${(err as Error).message}`);
    return false;
  }
}

async function fundWallet(wallet: TestWallet, mainKey?: string): Promise<void> {
  console.log(`  ${wallet.name} (${wallet.address})`);

  const balance = await getBalance(wallet.address);
  console.log(`    Balance: ${formatEther(balance)} WIP`);

  if (balance >= MIN_BALANCE) {
    console.log('    Sufficient balance, skipping');
    return;
  }

  // Try faucet first
  const faucetOk = await tryFaucet(wallet.address);
  if (faucetOk) {
    // Wait for faucet tx to be mined
    await new Promise((r) => setTimeout(r, 5000));
    const newBalance = await getBalance(wallet.address);
    if (newBalance >= MIN_BALANCE) {
      console.log(`    New balance: ${formatEther(newBalance)} WIP`);
      return;
    }
  }

  // Fallback: transfer from main wallet
  if (mainKey) {
    console.log('    Trying transfer from main wallet...');
    const ok = await transferFromMain(wallet.address, mainKey);
    if (ok) {
      await new Promise((r) => setTimeout(r, 5000));
      const newBalance = await getBalance(wallet.address);
      console.log(`    New balance: ${formatEther(newBalance)} WIP`);
    }
  } else {
    console.log('    WARNING: No main wallet key provided for fallback funding');
  }
}

async function main(): Promise<void> {
  console.log('Funding test wallets on Story Aeneid testnet...');
  console.log();

  const wallets = generateWallets();

  // Main wallet key from environment or config
  const mainKey = process.env.MAIN_WALLET_KEY;
  if (!mainKey) {
    console.log('NOTE: MAIN_WALLET_KEY not set. Faucet-only mode (no fallback transfers).');
    console.log();
  }

  for (const wallet of wallets) {
    await fundWallet(wallet, mainKey);
    console.log();
  }

  console.log('Funding complete.');
}

main().catch((err) => {
  console.error('Funding failed:', err);
  process.exit(1);
});
