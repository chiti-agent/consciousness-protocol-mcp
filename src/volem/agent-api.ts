import type { Config } from '../config/store.js';
import { jsonRequestBody, signedVolemRequest } from './client.js';
import { defaultVolemRequestJournal, type VolemRequestJournal } from './request-journal.js';

export const ACCEPTANCE_ACTIONS = [
  'preview',
  'start',
  'resume',
  'load',
  'cancel',
  'prepare',
  'record',
  'reconcile',
  'confirm',
  'finalize',
] as const;

export type AcceptanceAction = (typeof ACCEPTANCE_ACTIONS)[number];

export type AcceptanceOperation = {
  operationId: string;
  attemptId: string;
  kind: string;
  status: string;
  chainId: number | null;
  senderAddress: `0x${string}` | null;
  target: `0x${string}` | null;
  calldata: `0x${string}` | null;
  transactionValue: string | null;
  senderNonce: string | null;
  txHash: `0x${string}` | null;
  reconciliationOutcome: string | null;
  requiresReconciliation: boolean;
};

export type AcceptanceResponse = {
  success: boolean;
  code?: string;
  error?: string;
  operation?: AcceptanceOperation | null;
  resume?: unknown;
  outcome?: string;
  readyToSubmit?: boolean;
  readyToConfirm?: boolean;
  [key: string]: unknown;
};

const responseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Volem returned HTTP ${response.status} with a non-JSON response.`);
  }
};

export const listVolemThreads = async (config: Config, limit = 50): Promise<unknown> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Thread limit must be from 1 to 100.');
  const response = await fetch(`${config.volemApiUrl ?? 'http://localhost:3010'}/api/threads?limit=${limit}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return responseJson(response);
};

export const getVolemThread = async (config: Config, number: number): Promise<unknown> => {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Thread number must be a positive integer.');
  const response = await fetch(`${config.volemApiUrl ?? 'http://localhost:3010'}/api/threads/${number}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return responseJson(response);
};

const signedJson = async (input: {
  config: Config;
  action: 'thread.create' | 'thread.reply' | `acceptance.${AcceptanceAction}`;
  path: string;
  value: Record<string, unknown>;
  idempotencyKey?: string;
  journal?: VolemRequestJournal;
}): Promise<{ result: Record<string, unknown>; requestId: string; idempotencyKey: string }> => {
  const { response, request } = await signedVolemRequest({
    config: input.config,
    action: input.action,
    path: input.path,
    body: jsonRequestBody(input.value),
    idempotencyKey: input.idempotencyKey,
    journal: input.journal,
  });
  return {
    result: await responseJson<Record<string, unknown>>(response),
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
  };
};

export const createVolemThread = (input: {
  config: Config;
  title: string;
  body: string;
  idempotencyKey?: string;
  journal?: VolemRequestJournal;
}) => signedJson({ ...input, action: 'thread.create', path: '/api/threads', value: { title: input.title, body: input.body } });

export const replyToVolemThread = (input: {
  config: Config;
  parentId: string;
  body: string;
  idempotencyKey?: string;
  journal?: VolemRequestJournal;
}) =>
  signedJson({
    ...input,
    action: 'thread.reply',
    path: '/api/threads/replies',
    value: { parentId: input.parentId, body: input.body },
  });

export const runVolemAcceptance = async (input: {
  config: Config;
  action: AcceptanceAction;
  body: Record<string, unknown>;
  idempotencyKey?: string;
  journal?: VolemRequestJournal;
}): Promise<{ result: AcceptanceResponse; requestId: string; idempotencyKey: string }> => {
  const response = await signedJson({
    ...input,
    action: `acceptance.${input.action}`,
    path: '/api/contribution-acceptance',
    value: { action: input.action, ...input.body },
  });
  const result = response.result as AcceptanceResponse;
  const operationId = typeof input.body.operationId === 'string' ? input.body.operationId : null;
  const journal = input.journal ?? defaultVolemRequestJournal;
  if (result.success && operationId && input.action === 'record') {
    journal.closeBroadcast(operationId, 'RECORDED');
  } else if (result.success && operationId && input.action === 'reconcile' && result.outcome !== 'ABSENT') {
    journal.closeBroadcast(operationId, 'RECONCILED');
  }
  return { ...response, result };
};
