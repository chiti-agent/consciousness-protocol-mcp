import { createWalletClient, getAddress, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { story, storyAeneid } from 'viem/chains';

import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { runVolemAcceptance, type AcceptanceOperation, type AcceptanceResponse } from './agent-api.js';
import { defaultVolemRequestJournal, type VolemRequestJournal } from './request-journal.js';

type PreparedAcceptanceOperation = AcceptanceOperation & {
  senderAddress: `0x${string}`;
  target: `0x${string}`;
  calldata: `0x${string}`;
  transactionValue: string;
  senderNonce: string;
};

type SendPreparedTransaction = (operation: PreparedAcceptanceOperation) => Promise<`0x${string}`>;

const requiredPreparedOperation = (
  operation: AcceptanceOperation | null | undefined,
): PreparedAcceptanceOperation | null => {
  if (!operation) return null;
  if (
    operation.status !== 'PREPARED' ||
    operation.senderAddress === null ||
    operation.target === null ||
    operation.calldata === null ||
    operation.transactionValue === null ||
    operation.senderNonce === null
  ) {
    throw new Error('Volem returned an incomplete prepared acceptance operation.');
  }
  return operation as PreparedAcceptanceOperation;
};

const walletSender = (config: Config): SendPreparedTransaction => async (operation) => {
  const account = privateKeyToAccount(loadKey('evm') as `0x${string}`);
  if (account.address !== getAddress(operation.senderAddress)) {
    throw new Error('Prepared operation sender does not match the local wallet.');
  }
  const nonce = Number(operation.senderNonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Prepared operation nonce is invalid.');
  const chain = config.story.chainId === 'aeneid' ? storyAeneid : story;
  const wallet = createWalletClient({ account, chain, transport: http(config.story.rpcUrl) });
  return wallet.sendTransaction({
    account,
    chain,
    to: operation.target,
    data: operation.calldata,
    value: BigInt(operation.transactionValue),
    nonce,
  });
};

export const prepareBroadcastAndRecord = async (input: {
  config: Config;
  attemptId: string;
  idempotencyKey?: string;
  journal?: VolemRequestJournal;
  sendTransaction?: SendPreparedTransaction;
}): Promise<{
  phase: 'NOTHING_TO_SEND' | 'RECORDED' | 'RECORD_REQUIRED' | 'RECONCILIATION_REQUIRED';
  result: AcceptanceResponse;
  operationId?: string;
  txHash?: `0x${string}`;
}> => {
  const journal = input.journal ?? defaultVolemRequestJournal;
  const pending = journal.pendingBroadcasts().filter((entry) => entry.attemptId === input.attemptId);
  if (pending.length > 0) {
    const recoveryAction = pending.some((entry) => entry.recoveryAction === 'reconcile') ? 'reconcile' : 'record';
    return {
      phase: recoveryAction === 'reconcile' ? 'RECONCILIATION_REQUIRED' : 'RECORD_REQUIRED',
      result: {
        success: false,
        code: 'LOCAL_BROADCAST_RECOVERY_REQUIRED',
        error: `Resolve the journalled ${recoveryAction} operation before preparing another transaction.`,
        pendingBroadcasts: pending,
      },
      operationId: pending[0]?.operationId,
      txHash: pending[0]?.transactionHash,
    };
  }
  const prepared = await runVolemAcceptance({
    config: input.config,
    action: 'prepare',
    body: { attemptId: input.attemptId },
    idempotencyKey: input.idempotencyKey,
    journal,
  });
  if (!prepared.result.success) return { phase: 'NOTHING_TO_SEND', result: prepared.result };
  const operation = requiredPreparedOperation(prepared.result.operation);
  if (!operation) return { phase: 'NOTHING_TO_SEND', result: prepared.result };

  journal.recordBroadcastIntent({
    requestId: prepared.requestId,
    attemptId: input.attemptId,
    operationId: operation.operationId,
    sender: operation.senderAddress,
    transactionNonce: operation.senderNonce,
    target: operation.target,
    calldataHash: keccak256(operation.calldata),
    value: operation.transactionValue,
  });

  let txHash: `0x${string}`;
  try {
    txHash = await (input.sendTransaction ?? walletSender(input.config))(operation);
  } catch {
    const reconciled = await runVolemAcceptance({
      config: input.config,
      action: 'reconcile',
      body: { operationId: operation.operationId },
      journal,
    });
    return {
      phase: 'RECONCILIATION_REQUIRED',
      result: reconciled.result,
      operationId: operation.operationId,
    };
  }

  journal.recordBroadcastHash({
    requestId: prepared.requestId,
    operationId: operation.operationId,
    transactionHash: txHash,
  });
  const recorded = await runVolemAcceptance({
    config: input.config,
    action: 'record',
    body: { operationId: operation.operationId, txHash },
    journal,
  });
  if (recorded.result.success) {
    journal.closeBroadcast(operation.operationId, 'RECORDED');
  }
  return {
    phase: recorded.result.success ? 'RECORDED' : 'RECORD_REQUIRED',
    result: recorded.result,
    operationId: operation.operationId,
    txHash,
  };
};
