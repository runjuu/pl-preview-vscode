import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPreviewWorkspaceControlUrl,
  parsePreviewWorkspaceUrl,
} from '../src/previewWorkspaceUrl';

describe('Preview Workspace URLs', () => {
  it('preserves the owning Local Preview Session on page, status, reboot, and reset routes', () => {
    const parsed = parsePreviewWorkspaceUrl(
      'http://127.0.0.1:49812/preview-sessions/pvs_0123456789abcdefghijkl/workspace/42',
    );

    assert.deepEqual(parsed, {
      origin: 'http://127.0.0.1:49812',
      previewSessionId: 'pvs_0123456789abcdefghijkl',
      workspaceId: '42',
    });
    assert.equal(
      buildPreviewWorkspaceControlUrl(parsed!, 'status'),
      'http://127.0.0.1:49812/preview-sessions/pvs_0123456789abcdefghijkl/workspace/42/status',
    );
    assert.equal(
      buildPreviewWorkspaceControlUrl(parsed!, 'reboot'),
      'http://127.0.0.1:49812/preview-sessions/pvs_0123456789abcdefghijkl/workspace/42/reboot',
    );
    assert.equal(
      buildPreviewWorkspaceControlUrl(parsed!, 'reset'),
      'http://127.0.0.1:49812/preview-sessions/pvs_0123456789abcdefghijkl/workspace/42/reset',
    );
  });

  it('rejects removed unscoped and non-loopback workspace routes', () => {
    assert.equal(parsePreviewWorkspaceUrl('http://127.0.0.1:49812/workspace/42'), null);
    assert.equal(
      parsePreviewWorkspaceUrl(
        'https://example.test/preview-sessions/pvs_0123456789abcdefghijkl/workspace/42',
      ),
      null,
    );
  });
});
