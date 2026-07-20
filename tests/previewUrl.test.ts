import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_VARIANT, buildPreviewUrl, previewOrigin, randomBase36Variant } from '../src/previewUrl';

describe('previewOrigin', () => {
  it('is the loopback origin for the published port', () => {
    assert.equal(previewOrigin(49812), 'http://127.0.0.1:49812');
  });
});

describe('buildPreviewUrl', () => {
  const previewSessionId = 'pvs_0123456789abcdefghijkl';

  it('points at the session-scoped question endpoint on the loopback origin', () => {
    assert.equal(
      buildPreviewUrl({
        port: 49812,
        previewSessionId: 'pvs_0123456789abcdefghijkl',
        qid: 'arithmetic',
        variant: '1',
      }),
      'http://127.0.0.1:49812/preview-sessions/pvs_0123456789abcdefghijkl/questions/arithmetic?variant=1',
    );
  });

  it('defaults to the stable variant seed', () => {
    assert.equal(
      buildPreviewUrl({ port: 49812, previewSessionId, qid: 'arithmetic' }),
      `http://127.0.0.1:49812/preview-sessions/${previewSessionId}/questions/arithmetic?variant=${DEFAULT_VARIANT}`,
    );
  });

  it('preserves the separators of a nested qid but encodes each segment', () => {
    assert.equal(
      buildPreviewUrl({
        port: 4310,
        previewSessionId,
        qid: 'topic/sub/q1',
        variant: '1',
      }),
      `http://127.0.0.1:4310/preview-sessions/${previewSessionId}/questions/topic/sub/q1?variant=1`,
    );
    assert.equal(
      buildPreviewUrl({
        port: 4310,
        previewSessionId,
        qid: 'a b/c+d',
        variant: '1',
      }),
      `http://127.0.0.1:4310/preview-sessions/${previewSessionId}/questions/a%20b/c%2Bd?variant=1`,
    );
  });
});

describe('randomBase36Variant', () => {
  it('generates a non-empty base36 reroll seed', () => {
    assert.match(randomBase36Variant(), /^[0-9a-z]+$/);
  });

  it('generates a PrairieLearn-compatible 32-bit seed (>=1, fits uint32)', () => {
    const seed = randomBase36Variant();
    const parsed = Number.parseInt(seed, 36);

    assert.ok(Number.isSafeInteger(parsed));
    assert.ok(parsed >= 1);
    assert.ok(parsed <= 0xffffffff);
  });
});
