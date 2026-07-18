/**
 * Sweep funds from all test wallets (and any extra keys passed via env) to a
 * target address. Unwraps WIP first if present, then sends the native balance
 * minus gas headroom.
 *
 * Run: node --import tsx/esm tests/wallets/sweep.ts <target-address>
 * Env: SWEEP_EXTRA_KEYS=/path/a.json,/path/b.json — additional key files to drain.
 */

import { createWalletClient, createPublicClient, http, formatEther, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { generateWallets } from './generate-wallets.js';

const RPC = 'https://aeneid.storyrpc.io';
const CHAIN = {
  id: 1315,
  name: 'story-aeneid',
  nativeCurrency: { name: 'IP', symbol: 'IP', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const WIP = '0x1514000000000000000000000000000000000000' as const;
const WIP_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function withdraw(uint256)',
]);
// Native transfer 21k + WIP withdraw ~50k, при кэпнутых fee это доли цента
const GAS_HEADROOM_WEI = 200_000n * 100_000_000_000n; // 200k gas @ 100 gwei worst case

const target = process.argv[2] as `0x${string}`;
if (!/^0x[a-fA-F0-9]{40}$/.test(target ?? '')) {
  console.error('Usage: sweep.ts <target-address>');
  process.exit(1);
}

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

async function sweepOne(name: string, privateKey: `0x${string}`): Promise<bigint> {
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() === target.toLowerCase()) {
    console.log(`${name.padEnd(16)} ${account.address.slice(0, 10)}  = target, skip`);
    return 0n;
  }
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

  const wip = await pub.readContract({ address: WIP, abi: WIP_ABI, functionName: 'balanceOf', args: [account.address] });
  if (wip > 0n) {
    const hash = await wallet.writeContract({ address: WIP, abi: WIP_ABI, functionName: 'withdraw', args: [wip] });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`${name.padEnd(16)} unwrapped ${formatEther(wip)} WIP`);
  }

  const bal = await pub.getBalance({ address: account.address });
  if (bal <= GAS_HEADROOM_WEI) {
    console.log(`${name.padEnd(16)} ${account.address.slice(0, 10)}  ${formatEther(bal)} IP — dust, skip`);
    return 0n;
  }
  const amount = bal - GAS_HEADROOM_WEI;
  const hash = await wallet.sendTransaction({ to: target, value: amount });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`${name.padEnd(16)} ${account.address.slice(0, 10)}  sent ${formatEther(amount)} IP  (${hash.slice(0, 14)})`);
  return amount;
}

let total = 0n;
for (const w of generateWallets()) {
  try {
    total += await sweepOne(w.name, w.privateKey);
  } catch (e: any) {
    console.error(`${w.name}: FAILED — ${e.shortMessage ?? e.message}`);
  }
}
for (const extra of (process.env.SWEEP_EXTRA_KEYS ?? '').split(',').filter(Boolean)) {
  try {
    const j = JSON.parse(readFileSync(extra, 'utf-8'));
    total += await sweepOne(extra.split('/').pop() ?? extra, j.privateKey);
  } catch (e: any) {
    console.error(`${extra}: FAILED — ${e.shortMessage ?? e.message}`);
  }
}

console.log(`\nTOTAL swept: ${formatEther(total)} IP -> ${target}`);
console.log(`Target balance now: ${formatEther(await pub.getBalance({ address: target }))} IP`);
