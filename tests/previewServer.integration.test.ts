import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DockerPreviewRuntime } from '../src/dockerRuntime';
import { buildPreviewUrl } from '../src/previewUrl';

const pinnedImage = process.env.PL_PREVIEW_CONTRACT_IMAGE?.trim();
const workspaceSocket = process.env.PL_PREVIEW_CONTRACT_SOCKET?.trim();
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe('Local Preview Extension ↔ pinned experimental-1 image', () => {
  it(
    'creates and reuses a scoped full-mode session, renders current source, and cleans up',
    {
      skip:
        pinnedImage == null ? 'set PL_PREVIEW_CONTRACT_IMAGE to a published image digest' : false,
    },
    async () => {
      assert.match(
        pinnedImage!,
        /@sha256:[a-f0-9]{64}$/,
        'contract tests require an immutable digest, never latest or a mutable tag',
      );
      assert.doesNotMatch(pinnedImage!, /:latest(?:@|$)/);

      const courseRoot = await makeCourse('Initial experimental-1 render');
      const runtime = new DockerPreviewRuntime({ image: pinnedImage });
      try {
        assert.deepEqual(await runtime.checkAvailability(), {
          kind: 'available',
        });
        const first = await runtime.ensureRunning(courseRoot);
        const second = await runtime.ensureRunning(courseRoot);
        assert.deepEqual(second, first, 'warm reuse retains the owning Local Preview Session');

        const firstResponse = await fetch(
          buildPreviewUrl({ ...first, qid: 'freeform/v3', variant: '1' }),
        );
        assert.equal(firstResponse.status, 200);
        const firstHtml = await firstResponse.text();
        assert.match(firstHtml, /Initial experimental-1 render/);
        assert.match(
          firstHtml,
          /Save &amp; Grade/,
          'the server was launched in explicit full mode',
        );

        await fs.writeFile(
          path.join(courseRoot, 'questions/freeform/v3/question.html'),
          '<p>Refreshed experimental-1 render: Variant seed {{params.seed}}</p>\n' +
            '<pl-number-input answers-name="ans" label="$x =$"></pl-number-input>\n',
        );
        const refreshed = await fetch(
          buildPreviewUrl({ ...first, qid: 'freeform/v3', variant: '1' }),
        );
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /Refreshed experimental-1 render/);
      } finally {
        await runtime.stopAll();
      }
    },
  );

  it(
    'enables Preview Workspaces only when the runtime socket is explicitly supplied',
    {
      skip:
        pinnedImage == null || workspaceSocket == null
          ? 'set PL_PREVIEW_CONTRACT_IMAGE and PL_PREVIEW_CONTRACT_SOCKET'
          : false,
    },
    async () => {
      assert.match(pinnedImage!, /@sha256:[a-f0-9]{64}$/);
      const courseRoot = await makeCourse('Workspace-capable render');
      const runtime = new DockerPreviewRuntime({
        image: pinnedImage,
        workspaces: { dockerSocketPath: workspaceSocket! },
      });
      try {
        const running = await runtime.ensureRunning(courseRoot);
        const response = await fetch(
          buildPreviewUrl({ ...running, qid: 'freeform/v3', variant: '1' }),
        );
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Workspace-capable render/);
      } finally {
        await runtime.stopAll();
      }
    },
  );
});

async function makeCourse(marker: string): Promise<string> {
  const courseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-contract-'));
  tempRoots.push(courseRoot);
  const questionDir = path.join(courseRoot, 'questions/freeform/v3');
  await fs.mkdir(questionDir, { recursive: true });
  await fs.writeFile(
    path.join(courseRoot, 'infoCourse.json'),
    JSON.stringify({
      name: 'Local Preview Extension Contract',
      title: 'Local Preview Extension Contract',
      topics: [{ color: 'blue1', name: 'Testing' }],
    }),
  );
  await fs.writeFile(
    path.join(questionDir, 'info.json'),
    JSON.stringify({
      title: 'Freeform contract',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111225',
    }),
  );
  await fs.writeFile(
    path.join(questionDir, 'question.html'),
    `<p>${marker}: Variant seed {{params.seed}}</p>\n` +
      '<pl-number-input answers-name="ans" label="$x =$"></pl-number-input>\n',
  );
  await fs.writeFile(
    path.join(questionDir, 'server.py'),
    'def generate(data):\n' +
      '    data["params"]["seed"] = str(data["variant_seed"])\n' +
      '    data["correct_answers"]["ans"] = 2\n',
  );
  return courseRoot;
}
