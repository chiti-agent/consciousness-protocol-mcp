import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIpfs, resolveIpfsUrls } from '../src/ipfs.js';
import { assertVolemMatchesStory } from '../src/tools/content.js';
import { getCommittedContentHash, verifyMetadataCommitment } from '../src/story-metadata.js';

describe('IPFS delivery fallback', () => {
  it('puts the configured gateway first and removes duplicates', () => {
    const urls = resolveIpfsUrls('ipfs://QmExample/path.bin', 'https://ipfs.io/ipfs');
    assert.equal(urls[0], 'https://ipfs.io/ipfs/QmExample/path.bin');
    assert.equal(urls.filter((url) => url === urls[0]).length, 1);
    assert.ok(urls.includes('https://gateway.pinata.cloud/ipfs/QmExample/path.bin'));
  });

  it('rotates after an HTTP failure and returns the first successful gateway', async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return requested.length === 1
        ? new Response('rate limited', { status: 429 })
        : new Response('ciphertext', { status: 200 });
    };

    try {
      const result = await fetchIpfs('ipfs://QmExample', {
        preferredGateway: 'https://preferred.example/ipfs',
      });
      assert.equal(result.url, 'https://gateway.pinata.cloud/ipfs/QmExample');
      assert.equal(await result.response.text(), 'ciphertext');
      assert.equal(requested.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails with every attempted gateway visible', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('forbidden', { status: 403 });
    try {
      await assert.rejects(
        fetchIpfs('ipfs://QmUnavailable'),
        /gateway\.pinata\.cloud.*ipfs\.io.*dweb\.link.*w3s\.link/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Story metadata provenance', () => {
  const contentHash = 'ab'.repeat(32);
  const metadata = {
    title: 'Committed work',
    mediaUrl: 'ipfs://QmCiphertext',
    mediaType: 'application/vnd.volem.encrypted',
    attributes: [{ key: 'content_hash', value: contentHash }],
  };
  const raw = Buffer.from(JSON.stringify(metadata));
  const metadataHash = `0x${createHash('sha256').update(raw).digest('hex')}` as `0x${string}`;

  it('accepts metadata only when its bytes match the Story commitment', () => {
    const verified = verifyMetadataCommitment(raw, metadataHash);
    assert.deepEqual(verified, metadata);
    assert.equal(getCommittedContentHash(verified), contentHash);
  });

  it('rejects changed metadata bytes', () => {
    assert.throws(
      () => verifyMetadataCommitment(Buffer.from(JSON.stringify({ ...metadata, title: 'Changed' })), metadataHash),
      /metadata hash mismatch/i,
    );
  });

  it('rejects missing or malformed plaintext commitments', () => {
    assert.throws(() => getCommittedContentHash({ attributes: [] }), /content_hash/);
    assert.throws(
      () => getCommittedContentHash({ attributes: [{ key: 'content_hash', value: 'short' }] }),
      /content_hash/,
    );
  });

  it('fails closed when Volem disagrees with verified Story metadata', () => {
    assert.equal(
      assertVolemMatchesStory({ mediaUrl: metadata.mediaUrl, contentHash }, metadata, contentHash),
      metadata.mediaUrl,
    );
    assert.throws(
      () => assertVolemMatchesStory({ mediaUrl: 'ipfs://QmOther', contentHash }, metadata, contentHash),
      /mediaUrl does not match/,
    );
    assert.throws(
      () => assertVolemMatchesStory({ mediaUrl: metadata.mediaUrl, contentHash: 'cd'.repeat(32) }, metadata, contentHash),
      /contentHash does not match/,
    );
  });
});
