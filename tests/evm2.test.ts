import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeEvm2Envelope,
  createEvm2Authorization,
  encodeEvm2Envelope,
  evm2BodySha256,
  evm2Preimage,
  type Evm2Envelope,
} from '../src/volem/evm2.js';

const fixturePath = fileURLToPath(new URL('fixtures/evm2-golden.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  privateKey: `0x${string}`;
  bodyUtf8: string;
  envelope: Evm2Envelope;
  canonical: string;
  preimageHex: string;
  encoded: string;
  authorization: string;
};

describe('EVM2 client bytes', () => {
  it('reproduces the Volem golden vector byte for byte', async () => {
    const body = new TextEncoder().encode(fixture.bodyUtf8);
    assert.equal(evm2BodySha256(body), fixture.envelope.bodySha256);
    assert.equal(canonicalizeEvm2Envelope(fixture.envelope), fixture.canonical);
    assert.equal(`0x${Buffer.from(evm2Preimage(fixture.envelope)).toString('hex')}`, fixture.preimageHex);
    assert.equal(encodeEvm2Envelope(fixture.envelope), fixture.encoded);
    const signed = await createEvm2Authorization({
      privateKey: fixture.privateKey,
      domain: fixture.envelope.domain,
      chainId: fixture.envelope.chainId,
      path: fixture.envelope.path,
      action: fixture.envelope.action,
      body,
      identity: { nonce: fixture.envelope.nonce, idempotencyKey: fixture.envelope.idempotencyKey },
      issuedAt: fixture.envelope.issuedAt,
    });
    assert.equal(signed.authorization, fixture.authorization);
  });

  it('rejects query-bearing request paths instead of signing them', async () => {
    await assert.rejects(
      createEvm2Authorization({
        privateKey: fixture.privateKey,
        domain: fixture.envelope.domain,
        chainId: fixture.envelope.chainId,
        path: `${fixture.envelope.path}?action=preview`,
        action: fixture.envelope.action,
        body: new TextEncoder().encode(fixture.bodyUtf8),
      }),
      /query-free/,
    );
  });
});
