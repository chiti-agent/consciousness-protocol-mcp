import type { Config } from '../config/store.js';
import { loadKey } from '../config/store.js';
import { createLogger, type Logger } from '../logger.js';
import { createEvm2Authorization, type Evm2Action } from './evm2.js';
import { mayUseLegacyEvm, legacyDeadline, type LegacyEvmAction } from './legacy-deadline.js';
import {
  defaultVolemRequestJournal,
  type ActiveHttpRequest,
  type VolemRequestJournal,
} from './request-journal.js';

const log = createLogger({ base: { component: 'volem-client' } });

export const volemBaseUrl = (config: Config): string => {
  const raw = config.volemApiUrl ?? 'http://localhost:3010';
  const parsed = new URL(raw);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Volem API URL must be an origin without a path, query, or fragment.');
  }
  return parsed.origin;
};

export const volemChainId = (config: Config): number => (config.story.chainId === 'aeneid' ? 1315 : 1514);

export const jsonRequestBody = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const useLegacyMode = (environment: NodeJS.ProcessEnv): boolean => environment.CP_VOLEM_AUTH_MODE === 'V1';

const legacyAuthorization = async (privateKey: `0x${string}`): Promise<string> => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey);
  const timestamp = String(Date.now());
  const signature = await account.signMessage({ message: `volem:${timestamp}` });
  return `EVM ${account.address}:${timestamp}:${signature}`;
};

export type SignedVolemRequest = {
  response: Response;
  request: ActiveHttpRequest;
};

export const signedVolemRequest = async (input: {
  config: Config;
  action: Evm2Action;
  path: string;
  body?: Uint8Array;
  timeoutMs?: number;
  journal?: VolemRequestJournal;
  environment?: NodeJS.ProcessEnv;
  logger?: Logger;
  fetcher?: typeof fetch;
}): Promise<SignedVolemRequest> => {
  const body = input.body ?? new Uint8Array();
  const journal = input.journal ?? defaultVolemRequestJournal;
  const request = journal.beginHttpRequest(input.action, body);
  const privateKey = loadKey('evm') as `0x${string}`;
  const environment = input.environment ?? process.env;
  const logger = input.logger ?? log;
  const headers: Record<string, string> = {};
  if (body.byteLength > 0) headers['Content-Type'] = 'application/json';

  if (useLegacyMode(environment)) {
    if (!['ip.register', 'ip.event', 'ip.content-key'].includes(input.action)) {
      throw new Error(`V1 is not supported for ${input.action}.`);
    }
    const action = input.action as LegacyEvmAction;
    if (!mayUseLegacyEvm(action, new Date(), environment)) {
      throw new Error(`V1 fallback for ${action} is disabled or past its configured deadline.`);
    }
    headers.Authorization = await legacyAuthorization(privateKey);
    logger.warn('Using explicit Volem EVM V1 fallback', {
      action,
      deadline: legacyDeadline(action, environment)?.toISOString(),
    });
  } else {
    const signed = await createEvm2Authorization({
      privateKey,
      domain: volemBaseUrl(input.config),
      chainId: volemChainId(input.config),
      path: input.path,
      action: input.action,
      body,
      identity: journal.identity(request),
    });
    headers.Authorization = signed.authorization;
  }

  const response = await (input.fetcher ?? fetch)(`${volemBaseUrl(input.config)}${input.path}`, {
    method: 'POST',
    headers,
    body: body.byteLength ? Buffer.from(body) : undefined,
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });
  if (response.ok) journal.markTerminal(request.requestId, 'SUCCEEDED');
  else if (response.status < 500 && response.status !== 409 && response.status !== 429) {
    journal.markTerminal(request.requestId, 'FAILED');
  }
  return { response, request };
};
