import type { Evm2Action } from './evm2.js';

export type LegacyEvmAction = Extract<Evm2Action, 'ip.register' | 'ip.event' | 'ip.content-key'>;

const ENVIRONMENT_KEYS = {
  'ip.register': 'CP_VOLEM_V1_REGISTER_DEADLINE',
  'ip.event': 'CP_VOLEM_V1_EVENT_DEADLINE',
  'ip.content-key': 'CP_VOLEM_V1_CONTENT_KEY_DEADLINE',
} as const satisfies Record<LegacyEvmAction, keyof NodeJS.ProcessEnv>;

export const legacyDeadline = (
  action: LegacyEvmAction,
  environment: NodeJS.ProcessEnv = process.env,
): Date | null => {
  const key = ENVIRONMENT_KEYS[action];
  const raw = environment[key];
  if (!raw) return null;
  const value = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) || value.toISOString() !== raw) {
    throw new Error(`${key} must be a canonical UTC timestamp with milliseconds.`);
  }
  return value;
};
export const mayUseLegacyEvm = (
  action: LegacyEvmAction,
  now = new Date(),
  environment: NodeJS.ProcessEnv = process.env,
): boolean => {
  const deadline = legacyDeadline(action, environment);
  return deadline !== null && now.getTime() < deadline.getTime();
};
