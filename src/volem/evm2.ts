import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, sha256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const EVM2_MAX_LIFETIME_MS = 60_000;

export const EVM2_ACTIONS = [
  'ip.register',
  'ip.event',
  'ip.content-key',
  'thread.create',
  'thread.reply',
  'acceptance.preview',
  'acceptance.start',
  'acceptance.resume',
  'acceptance.load',
  'acceptance.cancel',
  'acceptance.prepare',
  'acceptance.record',
  'acceptance.reconcile',
  'acceptance.confirm',
  'acceptance.finalize',
] as const;

export type Evm2Action = (typeof EVM2_ACTIONS)[number];

export type Evm2Envelope = {
  v: 2;
  domain: string;
  chainId: number;
  address: `0x${string}`;
  method: 'POST';
  path: string;
  bodySha256: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
  nonce: `0x${string}`;
  action: Evm2Action;
  idempotencyKey: string;
};
export type Evm2RequestIdentity = {
  nonce: `0x${string}`;
  idempotencyKey: string;
};

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const BODY_HASH = /^0x[0-9a-f]{64}$/;
const NONCE = /^0x[0-9a-f]{32}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const assertEnvelope = (envelope: Evm2Envelope): Evm2Envelope => {
  for (const [field, value] of Object.entries(envelope)) {
    if (typeof value === 'string' && !ASCII_PRINTABLE.test(value)) {
      throw new Error(`EVM2 ${field} must be printable ASCII.`);
    }
  }
  if (envelope.v !== 2) throw new Error('EVM2 version must be 2.');
  if (!Number.isSafeInteger(envelope.chainId) || envelope.chainId < 1) {
    throw new Error('EVM2 chainId must be a positive safe integer.');
  }
  if (envelope.method !== 'POST') throw new Error('EVM2 currently permits POST only.');
  if (!envelope.path.startsWith('/') || envelope.path.includes('?') || envelope.path.includes('#')) {
    throw new Error('EVM2 path must be an exact query-free URL pathname.');
  }
  if (!BODY_HASH.test(envelope.bodySha256)) throw new Error('EVM2 body hash must be lowercase SHA-256 hex.');
  if (!NONCE.test(envelope.nonce)) throw new Error('EVM2 nonce must contain exactly 128 lowercase hex bits.');
  if (!UUID_V4.test(envelope.idempotencyKey)) throw new Error('EVM2 idempotency key must be a lowercase UUIDv4.');
  if (!EVM2_ACTIONS.includes(envelope.action)) throw new Error('EVM2 action is not registered.');
  if (getAddress(envelope.address) !== envelope.address) throw new Error('EVM2 address must use EIP-55 checksum.');
  if (!Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.expiresAt)) {
    throw new Error('EVM2 timestamps must be safe integer Unix milliseconds.');
  }
  if (envelope.expiresAt <= envelope.issuedAt || envelope.expiresAt - envelope.issuedAt > EVM2_MAX_LIFETIME_MS) {
    throw new Error('EVM2 validity window must be positive and at most 60 seconds.');
  }
  return envelope;
};

export const parseEvm2Audience = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new Error('EVM2 audience must be an exact HTTP(S) origin without a trailing slash.');
  }
  return value;
};

export const canonicalizeEvm2Envelope = (input: Evm2Envelope): string => {
  const envelope = assertEnvelope(input);
  return JSON.stringify({
    action: envelope.action,
    address: envelope.address,
    bodySha256: envelope.bodySha256,
    chainId: envelope.chainId,
    domain: envelope.domain,
    expiresAt: envelope.expiresAt,
    idempotencyKey: envelope.idempotencyKey,
    issuedAt: envelope.issuedAt,
    method: envelope.method,
    nonce: envelope.nonce,
    path: envelope.path,
    v: envelope.v,
  });
};

export const evm2Preimage = (envelope: Evm2Envelope): Uint8Array =>
  new TextEncoder().encode(canonicalizeEvm2Envelope(envelope));

export const evm2BodySha256 = (body: Uint8Array): `0x${string}` => sha256(body);

export const encodeEvm2Envelope = (envelope: Evm2Envelope): string =>
  Buffer.from(evm2Preimage(envelope)).toString('base64url');

export const newEvm2RequestIdentity = (): Evm2RequestIdentity => ({
  nonce: `0x${randomBytes(16).toString('hex')}`,
  idempotencyKey: randomUUID(),
});

export const createEvm2Authorization = async (input: {
  privateKey: `0x${string}`;
  domain: string;
  chainId: number;
  path: string;
  action: Evm2Action;
  body: Uint8Array;
  identity?: Evm2RequestIdentity;
  issuedAt?: number;
}): Promise<{ authorization: string; envelope: Evm2Envelope; canonical: string }> => {
  const account = privateKeyToAccount(input.privateKey);
  const issuedAt = input.issuedAt ?? Date.now();
  const identity = input.identity ?? newEvm2RequestIdentity();
  const envelope: Evm2Envelope = {
    v: 2,
    domain: parseEvm2Audience(input.domain),
    chainId: input.chainId,
    address: account.address,
    method: 'POST',
    path: input.path,
    bodySha256: evm2BodySha256(input.body),
    issuedAt,
    expiresAt: issuedAt + EVM2_MAX_LIFETIME_MS,
    nonce: identity.nonce,
    action: input.action,
    idempotencyKey: identity.idempotencyKey,
  };
  const canonical = canonicalizeEvm2Envelope(envelope);
  const signature = await account.signMessage({ message: { raw: toBytes(canonical) } });
  return {
    authorization: `EVM2 ${Buffer.from(canonical).toString('base64url')}.${signature}`,
    envelope,
    canonical,
  };
};
