import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { Disposable } from '../src/previewController';
import {
  type ActiveEditorSource,
  type PreviewabilitySink,
  PreviewabilityWatcher,
} from '../src/previewability';
import type { PreviewTarget } from '../src/previewTarget';

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { force: true, recursive: true })));
});

/** Active-editor source whose changes fire on demand, mirroring the VSCode adapter. */
class FakeSource implements ActiveEditorSource {
  private active: string | undefined;
  private readonly listeners: Array<() => void | Promise<void>> = [];

  constructor(
    private readonly folders: readonly string[] = [],
    active?: string,
  ) {
    this.active = active;
  }

  activeFilePath(): string | undefined {
    return this.active;
  }

  workspaceFolders(): readonly string[] {
    return this.folders;
  }

  onDidChangeActiveEditor(listener: () => void | Promise<void>): Disposable {
    this.listeners.push(listener);
    return { dispose: () => {} };
  }

  /** Switch the active editor and fire the change event, awaiting the listeners. */
  setActiveFile(filePath: string | undefined): Promise<void> {
    this.active = filePath;
    return Promise.all(this.listeners.map((listener) => listener())).then(() => {});
  }
}

/** Records every published previewability so tests can assert the sequence. */
class RecordingSink implements PreviewabilitySink {
  readonly published: boolean[] = [];

  setCanPreview(canPreview: boolean): void {
    this.published.push(canPreview);
  }

  get last(): boolean | undefined {
    return this.published.at(-1);
  }
}

const A_QUESTION = '/course/questions/arithmetic/question.html';
const someTarget: PreviewTarget = { courseRoot: '/course', qid: 'arithmetic', type: 'v3' };

describe('PreviewabilityWatcher', () => {
  it('publishes false when there is no active file', async () => {
    const sink = new RecordingSink();
    const watcher = new PreviewabilityWatcher({
      source: new FakeSource(),
      sink,
      resolveTarget: async () => someTarget,
    });
    await watcher.refresh();
    assert.equal(sink.last, false);
  });

  it('publishes true when the active file resolves to a question', async () => {
    const sink = new RecordingSink();
    const watcher = new PreviewabilityWatcher({
      source: new FakeSource(['/course'], A_QUESTION),
      sink,
      resolveTarget: async () => someTarget,
    });
    await watcher.refresh();
    assert.equal(sink.last, true);
  });

  it('publishes false when the active file is not a previewable question', async () => {
    const sink = new RecordingSink();
    const watcher = new PreviewabilityWatcher({
      source: new FakeSource(['/course'], '/course/README.md'),
      sink,
      resolveTarget: async () => null,
    });
    await watcher.refresh();
    assert.equal(sink.last, false);
  });

  it('re-evaluates on each active-editor change', async () => {
    const sink = new RecordingSink();
    const targets = new Map<string, PreviewTarget | null>([
      [A_QUESTION, someTarget],
      ['/course/notes.txt', null],
    ]);
    const source = new FakeSource(['/course']);
    new PreviewabilityWatcher({
      source,
      sink,
      resolveTarget: async (file) => targets.get(file) ?? null,
    });

    await source.setActiveFile(A_QUESTION);
    await source.setActiveFile('/course/notes.txt');

    assert.deepEqual(sink.published, [true, false]);
  });

  it('discards a slow earlier resolution superseded by a newer editor switch', async () => {
    const sink = new RecordingSink();
    const gates = new Map<string, (target: PreviewTarget | null) => void>();
    const source = new FakeSource(['/course']);
    new PreviewabilityWatcher({
      source,
      sink,
      resolveTarget: (file) =>
        new Promise((resolve) => {
          gates.set(file, resolve);
        }),
    });

    // Two switches are in flight; the newest (a stray file) settles first, then
    // the earlier question resolves late and must not overwrite the key.
    const first = source.setActiveFile(A_QUESTION);
    const second = source.setActiveFile('/course/notes.txt');
    gates.get('/course/notes.txt')?.(null);
    gates.get(A_QUESTION)?.(someTarget);
    await Promise.all([first, second]);

    assert.deepEqual(sink.published, [false]);
  });

  it('drops a resolution that settles after dispose', async () => {
    const sink = new RecordingSink();
    let release: ((target: PreviewTarget | null) => void) | undefined;
    const watcher = new PreviewabilityWatcher({
      source: new FakeSource(['/course'], A_QUESTION),
      sink,
      resolveTarget: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const pending = watcher.refresh();
    watcher.dispose();
    release?.(someTarget);
    await pending;

    assert.deepEqual(sink.published, []);
  });

  it('stops re-evaluating after dispose', async () => {
    const sink = new RecordingSink();
    const source = new FakeSource(['/course'], A_QUESTION);
    const watcher = new PreviewabilityWatcher({
      source,
      sink,
      resolveTarget: async () => someTarget,
    });

    watcher.dispose();
    await watcher.refresh();
    await source.setActiveFile(A_QUESTION);

    assert.deepEqual(sink.published, []);
  });

  it('uses the real filesystem resolver by default', async () => {
    const courseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-previewability-'));
    tempRoots.push(courseRoot);
    await fs.writeFile(path.join(courseRoot, 'infoCourse.json'), JSON.stringify({ name: 'T 101' }));
    const questionDir = path.join(courseRoot, 'questions', 'arithmetic');
    await fs.mkdir(questionDir, { recursive: true });
    await fs.writeFile(path.join(questionDir, 'info.json'), JSON.stringify({ type: 'v3' }));
    await fs.writeFile(path.join(questionDir, 'question.html'), '');
    await fs.writeFile(path.join(courseRoot, 'README.md'), '');

    const sink = new RecordingSink();
    const source = new FakeSource([courseRoot]);
    new PreviewabilityWatcher({ source, sink });

    await source.setActiveFile(path.join(questionDir, 'question.html'));
    assert.equal(sink.last, true, 'a question file lights the icon up');

    await source.setActiveFile(path.join(courseRoot, 'README.md'));
    assert.equal(sink.last, false, 'a stray file leaves the icon dark');
  });
});
