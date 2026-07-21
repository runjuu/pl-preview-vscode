import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  type ContainerRuntime,
  type Disposable,
  type EditorWorkspaceSource,
  PreviewController,
  type PreviewViewState,
  type Clock as PreviewClock,
  type PreviewViewSink,
} from '../src/previewController';
import { PREVIEW_PANEL_TITLE } from '../src/panel';
import type { PreviewTarget } from '../src/previewTarget';
import type { PreviewStartupProgress } from '../src/startupProgress';

const tempRoots: string[] = [];
const PREVIEW_SESSION_ID = 'pvs_0123456789abcdefghijkl';

async function makeCourse(): Promise<string> {
  const courseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-controller-'));
  tempRoots.push(courseRoot);
  await fs.writeFile(path.join(courseRoot, 'infoCourse.json'), JSON.stringify({ name: 'TEST 101' }));
  for (const qid of ['arithmetic', 'topic/sub/q1']) {
    const dir = path.join(courseRoot, 'questions', ...qid.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'info.json'), JSON.stringify({ title: `Q ${qid}`, type: 'v3' }));
    await fs.writeFile(path.join(dir, 'question.html'), '');
    await fs.writeFile(path.join(dir, 'server.py'), '');
  }
  await fs.mkdir(path.join(courseRoot, 'elements', 'pl-thing'), {
    recursive: true,
  });
  await fs.writeFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'), '');
  return courseRoot;
}

after(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { force: true, recursive: true })));
});

class FakeSource implements EditorWorkspaceSource {
  private active: string | undefined;
  private readonly folders: string[];
  private readonly activeListeners: Array<() => void | Promise<void>> = [];
  private readonly saveListeners: Array<(p: string) => void> = [];

  constructor(folders: string[]) {
    this.folders = folders;
  }

  activeFilePath(): string | undefined {
    return this.active;
  }

  workspaceFolders(): readonly string[] {
    return this.folders;
  }

  onDidChangeActiveEditor(listener: () => void | Promise<void>): Disposable {
    this.activeListeners.push(listener);
    return { dispose: () => {} };
  }

  onDidSaveDocument(listener: (savedPath: string) => void): Disposable {
    this.saveListeners.push(listener);
    return { dispose: () => {} };
  }

  /** Make a file the active editor without firing — models the file already open at start. */
  openFile(filePath: string): void {
    this.active = filePath;
  }

  /**
   * Switch the active editor and fire the change event, awaiting the listeners
   * so real-fs resolution settles. The deferred-runtime test intentionally does
   * not await the returned promise (its handler parks on ensureRunning).
   */
  setActiveFile(filePath: string | undefined): Promise<void> {
    this.active = filePath;
    return Promise.all(this.activeListeners.map((listener) => listener())).then(() => {});
  }

  save(filePath: string): void {
    for (const listener of this.saveListeners) listener(filePath);
  }
}

/**
 * Runtime that answers ensureRunning instantly on one stable server port and
 * records the session pool's `stop` / `stopAll` calls so tests can assert
 * eviction, reaping, and dispose-all through the port.
 */
class InstantRuntime implements ContainerRuntime {
  readonly calls: string[] = [];
  readonly stops: string[] = [];
  stopAllCount = 0;
  constructor(private readonly port = 49876) {}
  async ensureRunning(courseRoot: string): Promise<{ port: number; previewSessionId: string }> {
    this.calls.push(courseRoot);
    return { port: this.port, previewSessionId: PREVIEW_SESSION_ID };
  }
  async stop(courseRoot: string): Promise<void> {
    this.stops.push(courseRoot);
  }
  async stopAll(): Promise<void> {
    this.stopAllCount += 1;
  }
}

/** Runtime whose ensureRunning stays pending until the test settles it by index. */
class DeferredRuntime implements ContainerRuntime {
  readonly calls: string[] = [];
  readonly stops: string[] = [];
  stopAllCount = 0;
  private readonly resolvers: Array<(value: { port: number; previewSessionId: string }) => void> = [];
  private readonly rejecters: Array<(reason: unknown) => void> = [];
  async ensureRunning(courseRoot: string): Promise<{ port: number; previewSessionId: string }> {
    this.calls.push(courseRoot);
    return new Promise((resolve, reject) => {
      this.resolvers.push(resolve);
      this.rejecters.push(reject);
    });
  }
  async stop(courseRoot: string): Promise<void> {
    this.stops.push(courseRoot);
  }
  async stopAll(): Promise<void> {
    this.stopAllCount += 1;
  }
  resolveCall(index: number, port: number): void {
    this.resolvers[index]({ port, previewSessionId: PREVIEW_SESSION_ID });
  }
  rejectCall(index: number, reason: unknown): void {
    this.rejecters[index](reason);
  }
}

/** Runtime whose ensureRunning always fails, modelling a container launch failure. */
class ThrowingRuntime implements ContainerRuntime {
  readonly calls: string[] = [];
  readonly stops: string[] = [];
  stopAllCount = 0;
  constructor(private readonly error: unknown = new Error('docker daemon unreachable')) {}
  async ensureRunning(courseRoot: string): Promise<{ port: number; previewSessionId: string }> {
    this.calls.push(courseRoot);
    throw this.error;
  }
  async stop(courseRoot: string): Promise<void> {
    this.stops.push(courseRoot);
  }
  async stopAll(): Promise<void> {
    this.stopAllCount += 1;
  }
}

class FakeClock implements PreviewClock {
  private t = 0;
  private timers: Array<{ due: number; cb: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.t;
  }

  schedule(delayMs: number, callback: () => void): Disposable {
    const timer = { due: this.t + delayMs, cb: callback, cancelled: false };
    this.timers.push(timer);
    return { dispose: () => (timer.cancelled = true) };
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.due <= this.t);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.cb();
  }
}

class RecordingSink implements PreviewViewSink {
  readonly states: PreviewViewState[] = [];
  readonly titles: string[] = [];
  setState(state: PreviewViewState): void {
    this.states.push(state);
  }
  setTitle(title: string): void {
    this.titles.push(title);
  }
  get last(): PreviewViewState | undefined {
    return this.states[this.states.length - 1];
  }
  get lastTitle(): string | undefined {
    return this.titles[this.titles.length - 1];
  }
  kinds(): string[] {
    return this.states.map((state) => state.kind);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic reroll generator handing out a scripted sequence of seeds. */
function fakeVariants(seeds: string[]): () => string {
  let i = 0;
  return () => seeds[i++] ?? 'exhausted';
}

const DEBOUNCE = 200;

function makeController(
  courseRoot: string,
  overrides: {
    runtime?: ContainerRuntime;
    resolveTarget?: (file: string, folders: readonly string[]) => Promise<PreviewTarget | null>;
    nextVariant?: () => string;
    poolCap?: number;
    idleTtlMs?: number;
  } = {},
) {
  const source = new FakeSource([courseRoot]);
  const runtime = overrides.runtime ?? new InstantRuntime();
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const controller = new PreviewController({
    source,
    runtime,
    clock,
    sink,
    debounceMs: DEBOUNCE,
    resolveTarget: overrides.resolveTarget,
    nextVariant: overrides.nextVariant,
    poolCap: overrides.poolCap,
    idleTtlMs: overrides.idleTtlMs,
  });
  return { source, runtime, clock, sink, controller };
}

describe('PreviewController — active editor following', () => {
  let courseRoot: string;
  beforeEach(async () => {
    courseRoot = await makeCourse();
  });

  it('renders the active question: ensureRunning + starting then the loopback URL', async () => {
    const { source, runtime, sink, controller } = makeController(courseRoot);
    const instant = runtime as InstantRuntime;

    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();

    assert.deepEqual(instant.calls, [courseRoot]);
    assert.deepEqual(sink.kinds(), ['starting', 'preview']);
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=1`,
      variant: '1',
    });
  });

  it('encodes a nested qid in the preview URL', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'questions', 'topic', 'sub', 'q1', 'server.py'));
    await controller.start();
    await flush();
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/topic/sub/q1?variant=1`,
      variant: '1',
    });
  });

  it('shows an empty state for a file outside any question and never starts a container', async () => {
    const { source, runtime, sink, controller } = makeController(courseRoot);
    const instant = runtime as InstantRuntime;
    source.openFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    await controller.start();
    await flush();
    assert.deepEqual(sink.kinds(), ['empty']);
    assert.deepEqual(instant.calls, []);
  });

  it('shows an empty state when there is no active editor', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    // No file open at all.
    await controller.start();
    await flush();
    assert.deepEqual(sink.kinds(), ['empty']);
  });

  it('clears a stale render when switching from a question to a non-question', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();
    await source.setActiveFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    assert.equal(sink.last?.kind, 'empty');
  });

  it('keeps the preview (no re-render) when switching between files of the same question', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();
    const countAfterFirst = sink.states.length;

    await source.setActiveFile(path.join(courseRoot, 'questions', 'arithmetic', 'server.py'));
    assert.equal(sink.states.length, countAfterFirst, 'no extra state emitted for a sibling file');
  });
});

describe('PreviewController — panel tab title', () => {
  let courseRoot: string;
  beforeEach(async () => {
    courseRoot = await makeCourse();
  });

  it("names the tab after the question's info.json title, suffixed with (Preview)", async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();

    assert.equal(sink.lastTitle, 'Q arithmetic (Preview)');
  });

  it('falls back to the qid when info.json has no title', async () => {
    const untitled = path.join(courseRoot, 'questions', 'untitled');
    await fs.mkdir(untitled, { recursive: true });
    await fs.writeFile(path.join(untitled, 'info.json'), JSON.stringify({ type: 'v3' }));
    await fs.writeFile(path.join(untitled, 'question.html'), '');

    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(untitled, 'question.html'));
    await controller.start();
    await flush();

    assert.equal(sink.lastTitle, 'untitled (Preview)');
  });

  it('resets the tab to the default title when nothing is previewed', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    await controller.start();
    await flush();

    assert.equal(sink.lastTitle, PREVIEW_PANEL_TITLE);
  });

  it('exposes the current question name so a workspace tab can be named after it', async () => {
    const { source, controller } = makeController(courseRoot);
    assert.equal(controller.currentQuestionName(), undefined);

    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();

    assert.equal(controller.currentQuestionName(), 'Q arithmetic');
  });
});

describe('PreviewController — refresh on save', () => {
  let courseRoot: string;
  beforeEach(async () => {
    courseRoot = await makeCourse();
  });

  async function previewArithmetic() {
    const ctx = makeController(courseRoot);
    ctx.source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await ctx.controller.start();
    await flush();
    return ctx;
  }

  it('re-renders after a debounced save, without a starting flash', async () => {
    const { source, sink, clock } = await previewArithmetic();
    const before = sink.states.length;

    source.save(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    clock.advance(DEBOUNCE);
    await flush();

    assert.deepEqual(sink.states.slice(before), [
      {
        kind: 'preview',
        url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=1`,
        variant: '1',
      },
    ]);
  });

  it('collapses a burst of rapid saves into a single re-render', async () => {
    const { source, sink, runtime, clock } = await previewArithmetic();
    const rendersBefore = (runtime as InstantRuntime).calls.length;
    const statesBefore = sink.states.length;

    source.save(path.join(courseRoot, 'questions', 'arithmetic', 'server.py'));
    clock.advance(DEBOUNCE / 2);
    source.save(path.join(courseRoot, 'questions', 'arithmetic', 'server.py'));
    clock.advance(DEBOUNCE / 2);
    source.save(path.join(courseRoot, 'questions', 'arithmetic', 'server.py'));
    clock.advance(DEBOUNCE);
    await flush();

    assert.equal((runtime as InstantRuntime).calls.length, rendersBefore + 1);
    assert.equal(sink.states.length - statesBefore, 1);
  });

  it('does not refresh on save when nothing is being previewed', async () => {
    const { source, runtime, sink, clock, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    await controller.start();
    await flush();
    const before = sink.states.length;

    source.save(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    clock.advance(DEBOUNCE);
    await flush();

    assert.equal((runtime as InstantRuntime).calls.length, 0);
    assert.equal(sink.states.length, before);
  });

  it('refreshes immediately via the manual refresh command', async () => {
    const { sink, controller } = await previewArithmetic();
    const before = sink.states.length;
    await controller.refresh();
    await flush();
    assert.deepEqual(sink.states.slice(before), [
      {
        kind: 'preview',
        url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=1`,
        variant: '1',
      },
    ]);
  });
});

describe('PreviewController — stable preview variant', () => {
  let courseRoot: string;
  beforeEach(async () => {
    courseRoot = await makeCourse();
  });

  const arithmeticHtml = () => path.join(courseRoot, 'questions', 'arithmetic', 'question.html');
  const q1Server = () => path.join(courseRoot, 'questions', 'topic', 'sub', 'q1', 'server.py');

  it('renders a fresh question at the default stable seed and surfaces it to the sink', async () => {
    const { source, sink, controller } = makeController(courseRoot);
    source.openFile(arithmeticHtml());
    await controller.start();
    await flush();

    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=1`,
      variant: '1',
    });
  });

  it('keeps the same seed across a save-refresh (no randomness under the author)', async () => {
    const { source, sink, clock, controller } = makeController(courseRoot);
    source.openFile(arithmeticHtml());
    await controller.start();
    await flush();

    source.save(arithmeticHtml());
    clock.advance(DEBOUNCE);
    await flush();

    const previews = sink.states.filter((state) => state.kind === 'preview');
    assert.ok(previews.length >= 2, 'the save produced a second render');
    for (const state of previews) {
      assert.equal((state as { variant: string }).variant, '1');
    }
  });

  it('rerolls the seed and re-renders on New variant', async () => {
    const { source, sink, controller } = makeController(courseRoot, {
      nextVariant: fakeVariants(['abc']),
    });
    source.openFile(arithmeticHtml());
    await controller.start();
    await flush();
    const before = sink.states.length;

    await controller.newVariant();
    await flush();

    assert.deepEqual(sink.states.slice(before), [
      {
        kind: 'preview',
        url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=abc`,
        variant: 'abc',
      },
    ]);
  });

  it('keeps a rerolled seed stable across the next save-refresh', async () => {
    const { source, sink, clock, controller } = makeController(courseRoot, {
      nextVariant: fakeVariants(['abc']),
    });
    source.openFile(arithmeticHtml());
    await controller.start();
    await flush();
    await controller.newVariant();
    await flush();
    const before = sink.states.length;

    source.save(arithmeticHtml());
    clock.advance(DEBOUNCE);
    await flush();

    assert.deepEqual(sink.states.slice(before), [
      {
        kind: 'preview',
        url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=abc`,
        variant: 'abc',
      },
    ]);
  });

  it("persists each question's seed for the session across switching away and back", async () => {
    const { source, sink, controller } = makeController(courseRoot, {
      nextVariant: fakeVariants(['abc']),
    });
    source.openFile(arithmeticHtml());
    await controller.start();
    await flush();
    await controller.newVariant(); // arithmetic → 'abc'
    await flush();

    // Another question starts at the default seed, independent of arithmetic's.
    await source.setActiveFile(q1Server());
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/topic/sub/q1?variant=1`,
      variant: '1',
    });

    // Switching back to arithmetic remembers its rerolled seed.
    await source.setActiveFile(arithmeticHtml());
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/arithmetic?variant=abc`,
      variant: 'abc',
    });
  });

  it('ignores New variant when nothing is being previewed', async () => {
    const { source, sink, controller } = makeController(courseRoot, {
      nextVariant: fakeVariants(['abc']),
    });
    source.openFile(path.join(courseRoot, 'elements', 'pl-thing', 'pl-thing.py'));
    await controller.start();
    await flush();
    const before = sink.states.length;

    await controller.newVariant();
    await flush();

    assert.equal(sink.states.length, before);
  });
});

describe('PreviewController — concurrency and disposal', () => {
  let courseRoot: string;
  beforeEach(async () => {
    courseRoot = await makeCourse();
  });

  it('drops a stale in-flight render when the editor switches mid-start', async () => {
    const target: Record<string, PreviewTarget> = {
      A: { courseRoot, qid: 'arithmetic' },
      B: { courseRoot, qid: 'topic/sub/q1' },
    };
    const resolveTarget = async (file: string) => target[file] ?? null;
    const runtime = new DeferredRuntime();
    const { source, sink, controller } = makeController(courseRoot, {
      runtime,
      resolveTarget,
    });
    await controller.start();

    source.setActiveFile('A');
    await flush(); // handler A parks awaiting ensureRunning(A)
    source.setActiveFile('B');
    await flush(); // handler B parks awaiting ensureRunning(B)

    runtime.resolveCall(0, 1111); // A resolves late — must be discarded
    await flush();
    runtime.resolveCall(1, 2222); // B resolves — wins
    await flush();

    assert.deepEqual(runtime.calls, [courseRoot, courseRoot]);
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:2222/preview-sessions/${PREVIEW_SESSION_ID}/questions/topic/sub/q1?variant=1`,
      variant: '1',
    });
  });

  it('surfaces a not-previewable state for a type outside the six Source Question Types', async () => {
    const { source, runtime, sink, controller } = makeController(courseRoot, {
      resolveTarget: async () => ({
        courseRoot,
        qid: 'custom',
        type: 'ExternalCustomType',
      }),
    });
    source.openFile(path.join(courseRoot, 'questions', 'legacy', 'info.json'));
    await controller.start();
    await flush();

    assert.deepEqual(sink.kinds(), ['notPreviewable']);
    assert.deepEqual(sink.last, {
      kind: 'notPreviewable',
      type: 'ExternalCustomType',
    });
    assert.deepEqual((runtime as InstantRuntime).calls, [], 'no container is started for an unsupported type');
  });

  it('surfaces a render/launch failure as a loud error state carrying the failure message', async () => {
    const runtime = new ThrowingRuntime(new Error('Cannot connect to the Docker daemon'));
    const { source, sink, controller } = makeController(courseRoot, {
      runtime,
    });
    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();

    assert.deepEqual(sink.kinds(), ['starting', 'error']);
    assert.equal(sink.last?.kind, 'error');
    assert.match((sink.last as { message: string }).message, /Docker daemon/);
  });

  it('does not paint a stale error after the editor moved on to another question', async () => {
    const target: Record<string, PreviewTarget> = {
      A: { courseRoot, qid: 'arithmetic' },
      B: { courseRoot, qid: 'topic/sub/q1' },
    };
    const resolveTarget = async (file: string) => target[file] ?? null;
    const runtime = new DeferredRuntime();
    const { source, sink, controller } = makeController(courseRoot, {
      runtime,
      resolveTarget,
    });
    await controller.start();

    source.setActiveFile('A');
    await flush(); // handler A parks awaiting ensureRunning(A)
    source.setActiveFile('B');
    await flush(); // handler B parks awaiting ensureRunning(B)

    runtime.rejectCall(0, new Error('A failed late')); // stale — must be discarded
    await flush();
    runtime.resolveCall(1, 2222); // B resolves — wins
    await flush();

    assert.ok(!sink.kinds().includes('error'), 'the superseded failure never reaches the sink');
    assert.deepEqual(sink.last, {
      kind: 'preview',
      url: `http://127.0.0.1:2222/preview-sessions/${PREVIEW_SESSION_ID}/questions/topic/sub/q1?variant=1`,
      variant: '1',
    });
  });

  it('cancels a pending debounced refresh on dispose', async () => {
    const { source, sink, clock, controller } = makeController(courseRoot);
    source.openFile(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    await controller.start();
    await flush();
    const before = sink.states.length;

    source.save(path.join(courseRoot, 'questions', 'arithmetic', 'question.html'));
    controller.dispose();
    clock.advance(DEBOUNCE);
    await flush();

    assert.equal(sink.states.length, before, 'no render fires after dispose');
  });
});

describe('PreviewController — warm course-session pool', () => {
  // Synthetic multi-course targets resolved without touching the filesystem, so the
  // pool policy (reuse, LRU eviction, idle reaping, dispose-all) is exercised
  // directly through the ports. Each file name maps to a distinct course root.
  const TARGETS: Record<string, PreviewTarget> = {
    'a.html': { courseRoot: '/courses/a', qid: 'q', type: 'v3' },
    'b.html': { courseRoot: '/courses/b', qid: 'q', type: 'v3' },
    'c.html': { courseRoot: '/courses/c', qid: 'q', type: 'v3' },
  };
  const resolveTarget = async (file: string) => TARGETS[file] ?? null;

  function poolController(overrides: { poolCap?: number; idleTtlMs?: number } = {}) {
    return makeController('/courses', { resolveTarget, ...overrides });
  }

  /** Switch the active editor to `file` and settle its render. */
  async function preview(source: FakeSource, file: string): Promise<void> {
    await source.setActiveFile(file);
    await flush();
  }

  it('does not show a cold-start spinner when re-previewing a still-warm course', async () => {
    const { source, sink, controller } = poolController(); // default cap 2

    source.openFile('a.html');
    await controller.start(); // course A cold-starts
    await flush();
    await preview(source, 'b.html'); // course B cold-starts; A stays warm (cap 2)

    const before = sink.states.length;
    await preview(source, 'a.html'); // A is still warm → straight to the render

    assert.deepEqual(
      sink.states.slice(before).map((state) => state.kind),
      ['preview'],
      're-previewing a warm course renders without a starting flash',
    );
    assert.equal(
      (sink.last as { url: string }).url,
      `http://127.0.0.1:49876/preview-sessions/${PREVIEW_SESSION_ID}/questions/q?variant=1`,
    );
  });

  it('evicts the least-recently-used course when the pool cap is exceeded', async () => {
    // A large idle TTL keeps reaping out of the way so only LRU eviction fires.
    const { source, sink, runtime, controller } = poolController({
      poolCap: 2,
      idleTtlMs: 1e9,
    });
    const rt = runtime as InstantRuntime;

    source.openFile('a.html');
    await controller.start(); // warm: [a]
    await flush();
    await preview(source, 'b.html'); // warm: [a, b]
    await preview(source, 'c.html'); // a is LRU → evicted; warm: [b, c]

    assert.deepEqual(rt.stops, ['/courses/a'], 'the least-recently-used course is stopped');

    // b is still warm → re-previewing it renders without a cold-start spinner.
    const before = sink.states.length;
    await preview(source, 'b.html');
    assert.deepEqual(
      sink.states.slice(before).map((state) => state.kind),
      ['preview'],
    );
  });

  it('reaps a session left idle past the TTL while keeping the on-screen course warm', async () => {
    const { source, runtime, clock, controller } = poolController({
      poolCap: 3,
      idleTtlMs: 1_000,
    });
    const rt = runtime as InstantRuntime;

    source.openFile('a.html');
    await controller.start();
    await flush();
    await preview(source, 'b.html');
    await preview(source, 'c.html'); // current = c; warm: [a, b, c]

    clock.advance(1_000); // every idle window elapses at once
    await flush();

    // a and b were switched away from → reaped; c is on screen → kept warm.
    assert.deepEqual(rt.stops.slice().sort(), ['/courses/a', '/courses/b']);
  });

  it("resets a course's idle window each time it is re-previewed", async () => {
    const { source, runtime, clock, controller } = poolController({
      poolCap: 3,
      idleTtlMs: 1_000,
    });
    const rt = runtime as InstantRuntime;

    source.openFile('a.html');
    await controller.start();
    await flush();
    await preview(source, 'b.html');
    await preview(source, 'c.html'); // warm: [a, b, c]; every idle window due at 1000

    clock.advance(600); // t=600: nothing reaped yet
    await preview(source, 'a.html'); // touch a → its idle window resets to 1600
    clock.advance(500); // t=1100: b and c (due 1000) elapse; a (due 1600) survives
    await flush();

    assert.deepEqual(rt.stops.slice().sort(), ['/courses/b', '/courses/c']);
    assert.ok(!rt.stops.includes('/courses/a'), 'the recently re-previewed course is not reaped');
  });

  it('stops the shared server and cold-starts again after "Stop preview server"', async () => {
    const { source, sink, runtime, controller } = poolController();
    const rt = runtime as InstantRuntime;

    source.openFile('a.html');
    await controller.start();
    await flush();

    await controller.stopServers();
    assert.equal(rt.stopAllCount, 1, 'the shared server is stopped');
    assert.equal(sink.last?.kind, 'empty', 'the panel returns to the empty state');

    // The pool is cleared, so re-previewing the same course cold-starts again.
    const before = sink.states.length;
    await preview(source, 'a.html');
    assert.deepEqual(
      sink.states.slice(before).map((state) => state.kind),
      ['starting', 'preview'],
    );
  });

  it('stops the shared server on dispose (window close)', async () => {
    const { source, runtime, controller } = poolController();
    const rt = runtime as InstantRuntime;

    source.openFile('a.html');
    await controller.start();
    await flush();
    await preview(source, 'b.html');

    controller.dispose();
    assert.equal(rt.stopAllCount, 1, 'closing the window disposes the shared server');
  });
});

describe('PreviewController — startup progress', () => {
  // Synthetic targets: two questions share course /courses/a (so the second is a
  // warm re-preview), plus a distinct course /courses/b for supersession.
  const TARGETS: Record<string, PreviewTarget> = {
    'a1.html': { courseRoot: '/courses/a', qid: 'q1', type: 'v3' },
    'a2.html': { courseRoot: '/courses/a', qid: 'q2', type: 'v3' },
    'b.html': { courseRoot: '/courses/b', qid: 'q', type: 'v3' },
  };
  const resolveTarget = async (file: string) => TARGETS[file] ?? null;

  /** Runtime that replays a scripted progress sequence into onProgress before resolving. */
  class ProgressRuntime implements ContainerRuntime {
    readonly calls: string[] = [];
    stopAllCount = 0;
    constructor(
      private readonly port = 49876,
      private readonly script: PreviewStartupProgress[] = [
        { phase: 'pullingImage', percent: 10, layersDone: 1, layersTotal: 4 },
        { phase: 'startingContainer' },
      ],
    ) {}
    async ensureRunning(
      courseRoot: string,
      onProgress?: (progress: PreviewStartupProgress) => void,
    ): Promise<{ port: number; previewSessionId: string }> {
      this.calls.push(courseRoot);
      for (const step of this.script) onProgress?.(step);
      return { port: this.port, previewSessionId: PREVIEW_SESSION_ID };
    }
    async stop(): Promise<void> {}
    async stopAll(): Promise<void> {
      this.stopAllCount += 1;
    }
  }

  function makeProgressController(runtime: ContainerRuntime) {
    const source = new FakeSource(['/courses']);
    const sink = new RecordingSink();
    const controller = new PreviewController({
      source,
      runtime,
      clock: new FakeClock(),
      sink,
      resolveTarget,
    });
    return { source, sink, controller };
  }

  /** The `progress` payloads of every `starting` state the sink recorded, in order. */
  function progressStates(sink: RecordingSink): Array<PreviewStartupProgress | undefined> {
    return sink.states
      .filter((state) => state.kind === 'starting')
      .map((state) => (state as { progress?: PreviewStartupProgress }).progress);
  }

  it('forwards each cold-start progress tick into the starting overview before the preview', async () => {
    const { source, sink, controller } = makeProgressController(new ProgressRuntime());

    source.openFile('a1.html');
    await controller.start();
    await flush();

    // The payload-less starting, then one starting per progress tick, then the preview.
    assert.deepEqual(sink.kinds(), ['starting', 'starting', 'starting', 'preview']);
    assert.deepEqual(progressStates(sink), [
      undefined,
      { phase: 'pullingImage', percent: 10, layersDone: 1, layersTotal: 4 },
      { phase: 'startingContainer' },
    ]);
  });

  it('shows no overview and forwards no progress when re-previewing a warm course', async () => {
    const { source, sink, controller } = makeProgressController(new ProgressRuntime());

    source.openFile('a1.html');
    await controller.start(); // cold-starts /courses/a → forwards progress
    await flush();

    const before = sink.states.length;
    await source.setActiveFile('a2.html'); // same course, already warm
    await flush();

    // A warm re-preview renders straight through — no starting states at all.
    assert.deepEqual(
      sink.states.slice(before).map((state) => state.kind),
      ['preview'],
    );
  });

  it('drops a superseded cold start’s late progress instead of painting over newer state', async () => {
    const progressFns: Array<((progress: PreviewStartupProgress) => void) | undefined> = [];
    const resolvers: Array<(value: { port: number; previewSessionId: string }) => void> = [];
    const runtime: ContainerRuntime = {
      async ensureRunning(_courseRoot, onProgress) {
        progressFns.push(onProgress);
        return new Promise((resolve) => resolvers.push(resolve));
      },
      async stop() {},
      async stopAll() {},
    };
    const { source, sink, controller } = makeProgressController(runtime);

    // start() with no active file resolves to empty; the parking renders are then
    // driven through un-awaited setActiveFile + flush (ensureRunning never settles).
    await controller.start();
    source.setActiveFile('a1.html'); // render A parks on ensureRunning; A's onProgress at index 0
    await flush();
    source.setActiveFile('b.html'); // supersede: render B bumps the render token, then parks
    await flush();

    const before = sink.states.length;
    progressFns[0]?.({ phase: 'pullingImage', layersDone: 1, layersTotal: 4 }); // A's stale, late tick

    assert.equal(sink.states.length, before, 'the superseded start’s progress is dropped');
  });
});
