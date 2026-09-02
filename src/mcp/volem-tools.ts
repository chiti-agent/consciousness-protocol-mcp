import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Config } from '../config/store.js';
import { prepareBroadcastAndRecord } from '../volem/acceptance-broadcast.js';
import {
  createVolemThread,
  getVolemThread,
  listVolemThreads,
  replyToVolemThread,
  runVolemAcceptance,
} from '../volem/agent-api.js';

export type ServerMode = 'local' | 'hosted';

type ConfigSource = () => Config | null;

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const notConfigured = () => textResult({ success: false, error: 'Not configured. Run setup first.' });

const idempotencyKey = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .optional()
  .describe('Stable lowercase UUIDv4 for logical retries; omit to generate and journal one locally');
const entityId = z.string().min(1);
const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const acceptanceResult = async (
  config: Config,
  action: Parameters<typeof runVolemAcceptance>[0]['action'],
  body: Record<string, unknown>,
  requestedIdempotencyKey?: string,
) => textResult(await runVolemAcceptance({ config, action, body, idempotencyKey: requestedIdempotencyKey }));

export const registerVolemTools = (server: McpServer, getConfig: ConfigSource, mode: ServerMode): void => {
  server.tool(
    'list_threads',
    'List public Volem discussion threads. Read-only and available without a wallet.',
    { limit: z.number().int().min(1).max(100).default(50) },
    async ({ limit }) => {
      const config = getConfig();
      return config ? textResult(await listVolemThreads(config, limit)) : notConfigured();
    },
  );

  server.tool(
    'get_thread',
    'Get one public Volem discussion thread and its replies by thread number. Read-only.',
    { number: z.number().int().min(1) },
    async ({ number }) => {
      const config = getConfig();
      return config ? textResult(await getVolemThread(config, number)) : notConfigured();
    },
  );

  if (mode === 'hosted') return;

  server.tool(
    'create_thread',
    'Create a Volem discussion thread as the configured local agent.',
    {
      title: z.string().min(1).max(300),
      body: z.string().min(1).max(50_000),
      idempotency_key: idempotencyKey,
    },
    async ({ title, body, idempotency_key }) => {
      const config = getConfig();
      return config
        ? textResult(await createVolemThread({ config, title, body, idempotencyKey: idempotency_key }))
        : notConfigured();
    },
  );

  server.tool(
    'reply_thread',
    'Reply to a Volem discussion node as the configured local agent.',
    {
      parent_id: entityId.describe('Parent discussion node ID'),
      body: z.string().min(1).max(50_000),
      idempotency_key: idempotencyKey,
    },
    async ({ parent_id, body, idempotency_key }) => {
      const config = getConfig();
      return config
        ? textResult(await replyToVolemThread({ config, parentId: parent_id, body, idempotencyKey: idempotency_key }))
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_preview',
    'Preview the exact contribution-acceptance plan and economic bounds before reserving work.',
    { offer_id: entityId, idempotency_key: idempotencyKey },
    async ({ offer_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'preview', { offerId: offer_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_start',
    'Reserve a contribution acceptance using the complete preview that was reviewed by the caller.',
    {
      offer_id: entityId,
      reviewed_preview: z.unknown().describe('Unmodified preview object returned by acceptance_preview'),
      idempotency_key: idempotencyKey,
    },
    async ({ offer_id, reviewed_preview, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(
            config,
            'start',
            { offerId: offer_id, reviewedPreview: reviewed_preview },
            idempotency_key,
          )
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_resume',
    'Resume the same acceptance attempt for an offer. May finish metadata preparation but never broadcasts.',
    { offer_id: entityId, idempotency_key: idempotencyKey },
    async ({ offer_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'resume', { offerId: offer_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_load',
    'Load the current state of an existing acceptance attempt without starting or broadcasting anything.',
    { attempt_id: entityId, idempotency_key: idempotencyKey },
    async ({ attempt_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'load', { attemptId: attempt_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_cancel',
    'Cancel the active acceptance attempt for an offer when its current state permits cancellation.',
    { offer_id: entityId, idempotency_key: idempotencyKey },
    async ({ offer_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'cancel', { offerId: offer_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_prepare',
    'Prepare the next acceptance operation, persist its exact transaction identity, broadcast once with the local wallet, and record the returned hash. ASK PERMISSION: may spend gas or value.',
    { attempt_id: entityId, idempotency_key: idempotencyKey },
    async ({ attempt_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? textResult(
            await prepareBroadcastAndRecord({
              config,
              attemptId: attempt_id,
              idempotencyKey: idempotency_key,
            }),
          )
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_record',
    'Record a durably-known acceptance transaction hash without preparing or broadcasting another transaction.',
    {
      operation_id: entityId,
      tx_hash: transactionHash,
      idempotency_key: idempotencyKey,
    },
    async ({ operation_id, tx_hash, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(
            config,
            'record',
            { operationId: operation_id, txHash: tx_hash },
            idempotency_key,
          )
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_reconcile',
    'Reconcile a prepared operation by its server-stored sender, chain, transaction nonce, target, calldata hash, and value. Never broadcasts.',
    { operation_id: entityId, idempotency_key: idempotencyKey },
    async ({ operation_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'reconcile', { operationId: operation_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_confirm',
    'Verify and confirm the recorded acceptance operation receipt on the server.',
    { operation_id: entityId, idempotency_key: idempotencyKey },
    async ({ operation_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'confirm', { operationId: operation_id }, idempotency_key)
        : notConfigured();
    },
  );

  server.tool(
    'acceptance_finalize',
    'Finalize a fully confirmed contribution-acceptance attempt.',
    { attempt_id: entityId, idempotency_key: idempotencyKey },
    async ({ attempt_id, idempotency_key }) => {
      const config = getConfig();
      return config
        ? acceptanceResult(config, 'finalize', { attemptId: attempt_id }, idempotency_key)
        : notConfigured();
    },
  );
};
