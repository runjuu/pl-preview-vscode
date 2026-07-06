import { previewPanelTitle } from './panel';
import { DEFAULT_VARIANT, buildPreviewUrl, randomBase36Variant } from './previewUrl';
import { type PreviewTarget, isPreviewableType, resolvePreviewTarget } from './previewTarget';
import type { PreviewStartupProgress } from './startupProgress';

/**
 * The VSCode-agnostic orchestrator behind the editor-following preview.
 *
 * All load-bearing behavior lives here, driven through injected ports so it can
 * be unit-tested with fakes and a fake clock — no real Docker, VSCode, or
 * webview. The thin imperative shell (`extension.ts`) wires the real VSCode
 * adapters to these ports.
 *
 * This controller owns: active-editor target resolution → view state, container
 * start via the runtime, save-debounced / manual refresh, the Stable Preview
 * Variant seed state + reroll (#173), the `notPreviewable` / `error` states
 * (#174), and the warm-pool policy — LRU eviction, idle reaping, and dispose-all
 * (#175), driven through the runtime's `stop` / `stopAll` ports.
 */

/** A subscription the caller disposes to stop receiving events. */
export interface Disposable {
  dispose(): void;
}

/** Supplies the active file and workspace, and notifies on editor/save events. */
export interface EditorWorkspaceSource {
  /** Absolute path of the active editor's file, or `undefined` when there is none. */
  activeFilePath(): string | undefined;
  /** Absolute paths of the open workspace folders. */
  workspaceFolders(): readonly string[];
  /**
   * Fires when the active editor changes (including to/from no editor). The
   * listener may be async; its result is awaited by the source in tests and
   * ignored by the real VSCode adapter, matching VSCode event semantics.
   */
  onDidChangeActiveEditor(listener: () => void | Promise<void>): Disposable;
  /** Fires when a document is saved, with its absolute path. */
  onDidSaveDocument(listener: (savedPath: string) => void): Disposable;
}

/**
 * Starts, reuses, and stops the Local Preview Container(s), keyed by course root.
 *
 * The warm-pool *policy* (LRU cap, idle reaping, dispose-all) lives in the
 * {@link PreviewController}, which drives this port: it calls {@link stop} to
 * evict the least-recently-used course or reap an idle one, and {@link stopAll}
 * on window close / the "Stop preview servers" command. The runtime itself only
 * owns the container I/O.
 */
export interface ContainerRuntime {
  /**
   * Start or reuse the container for `courseRoot`, returning its loopback port. On a
   * cold start, `onProgress` receives the pull → start → readiness phases so the
   * controller can drive the "Starting preview…" overview.
   */
  ensureRunning(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<{ port: number }>;
  /** Stop and remove the container for `courseRoot` (LRU eviction / idle reaping). */
  stop(courseRoot: string): Promise<void>;
  /** Stop every container the runtime started (window close / Stop preview servers). */
  stopAll(): Promise<void>;
}

/** Time source with cancellable scheduling, so debouncing is deterministic under test. */
export interface Clock {
  now(): number;
  schedule(delayMs: number, callback: () => void): Disposable;
}

/** The view state the webview shell should display. */
export type PreviewViewState =
  | { readonly kind: 'empty' }
  /** The cold-start overview; `progress` refines the active phase/percent as it advances. */
  | { readonly kind: 'starting'; readonly progress?: PreviewStartupProgress }
  | { readonly kind: 'preview'; readonly url: string; readonly variant: string }
  /** The question's `info.json` `type` is not v3/Freeform, so it cannot be rendered. */
  | { readonly kind: 'notPreviewable'; readonly type: string }
  /**
   * A render or container-launch failure. `message` is a short human summary; the
   * full traceback lives in the runtime's Output channel, which the shell reveals
   * via its "Show logs" action.
   */
  | { readonly kind: 'error'; readonly message: string };

/** Receives the state to display. Implemented by the webview shell; a fake in tests. */
export interface PreviewViewSink {
  setState(state: PreviewViewState): void;
  /**
   * Set the panel's tab title (e.g. `"Random arithmetic (Preview)"`), so the tab
   * names the question being previewed rather than a generic "PL Preview". Tracks
   * the current target independently of {@link setState}'s inner content.
   */
  setTitle(title: string): void;
}

export interface PreviewControllerDeps {
  readonly source: EditorWorkspaceSource;
  readonly runtime: ContainerRuntime;
  readonly clock: Clock;
  readonly sink: PreviewViewSink;
  /** Debounce window for refresh-on-save. Defaults to {@link DEFAULT_SAVE_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Max warm courses kept before LRU eviction. Defaults to {@link DEFAULT_POOL_CAP}. */
  readonly poolCap?: number;
  /** Idle time before a warm course is reaped. Defaults to {@link DEFAULT_IDLE_TTL_MS}. */
  readonly idleTtlMs?: number;
  /** Preview-target resolver; defaults to the real filesystem resolver. */
  readonly resolveTarget?: (
    activeFilePath: string,
    workspaceFolders: readonly string[],
  ) => Promise<PreviewTarget | null>;
  /** Fresh reroll seed for "New variant"; defaults to {@link randomBase36Variant}. */
  readonly nextVariant?: () => string;
  /**
   * Optional diagnostic sink for human-readable trace lines. The extension routes
   * it to the "PL Preview" Output channel so a save→refresh flow can be inspected;
   * defaults to a no-op so unit tests stay quiet.
   */
  readonly log?: (message: string) => void;
}

/** Default debounce so a burst of rapid saves collapses to one render. */
export const DEFAULT_SAVE_DEBOUNCE_MS = 250;

/** Default LRU cap: keep a couple of courses warm so switching between them is fast. */
export const DEFAULT_POOL_CAP = 2;

/** Default idle TTL (~15 min): reap a container the author has stopped using. */
export const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

export class PreviewController {
  private readonly source: EditorWorkspaceSource;
  private readonly runtime: ContainerRuntime;
  private readonly clock: Clock;
  private readonly sink: PreviewViewSink;
  private readonly debounceMs: number;
  private readonly poolCap: number;
  private readonly idleTtlMs: number;
  private readonly resolveTarget: (
    activeFilePath: string,
    workspaceFolders: readonly string[],
  ) => Promise<PreviewTarget | null>;
  private readonly nextVariant: () => string;
  private readonly log: (message: string) => void;

  private readonly subscriptions: Disposable[] = [];
  private currentTarget: PreviewTarget | undefined;
  private pendingRefresh: Disposable | undefined;
  /** Monotonic token; a render whose token is stale on resume is discarded. */
  private renderToken = 0;
  private disposed = false;
  /**
   * Stable variant seed per previewed question for the session, keyed by
   * {@link targetKey}. Absent until a question is rerolled; a missing entry means
   * the default seed. Persisting the map is what keeps a question's variant stable
   * across refreshes and when the author switches away and back.
   */
  private readonly seeds = new Map<string, string>();
  /**
   * Warm courses keyed by course root, ordered least- to most-recently-used
   * (Map preserves insertion order; a course is deleted and re-set on each use to
   * move it to the end). Each entry holds the cancellable idle-reap timer. This is
   * the warm-pool state: membership decides whether a re-preview cold-starts, the
   * ordering drives LRU eviction, and the timers drive idle reaping.
   */
  private readonly warm = new Map<string, WarmEntry>();

  constructor(deps: PreviewControllerDeps) {
    this.source = deps.source;
    this.runtime = deps.runtime;
    this.clock = deps.clock;
    this.sink = deps.sink;
    this.debounceMs = deps.debounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
    this.poolCap = deps.poolCap ?? DEFAULT_POOL_CAP;
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.resolveTarget = deps.resolveTarget ?? resolvePreviewTarget;
    this.nextVariant = deps.nextVariant ?? randomBase36Variant;
    this.log = deps.log ?? (() => {});

    this.subscriptions.push(
      this.source.onDidChangeActiveEditor(() => this.handleActiveEditorChange()),
      this.source.onDidSaveDocument((savedPath) => {
        this.handleSave(savedPath);
      }),
    );
  }

  /** Render whatever the active editor currently points at. */
  async start(): Promise<void> {
    await this.handleActiveEditorChange();
  }

  /** Force an immediate re-render of the current preview (manual command). */
  async refresh(): Promise<void> {
    this.cancelPendingRefresh();
    if (this.currentTarget) {
      await this.render(this.currentTarget, { showStarting: false });
    }
  }

  /**
   * Reroll the current question's Stable Preview Variant seed and re-render it, so
   * the author can check the question across randomized variants. A no-op when
   * nothing is being previewed. The new seed is remembered for the session, so
   * subsequent refreshes stay on the rerolled variant.
   */
  async newVariant(): Promise<void> {
    if (this.disposed || !this.currentTarget) return;
    this.cancelPendingRefresh();
    this.seeds.set(targetKey(this.currentTarget), this.nextVariant());
    await this.render(this.currentTarget, { showStarting: false });
  }

  /**
   * The display name of the question currently being previewed — its `info.json`
   * title, or the qid as a fallback — or `undefined` when nothing is previewed.
   * Lets the shell name a workspace tab after the question that opened it.
   */
  currentQuestionName(): string | undefined {
    const target = this.currentTarget;
    return target ? (target.title ?? target.qid) : undefined;
  }

  /**
   * Stop every running preview container on demand (the "Stop preview servers"
   * command). Clears the warm pool and returns the panel to the empty state; the
   * next edit or editor switch cold-starts a fresh container.
   */
  async stopServers(): Promise<void> {
    this.clearPool();
    this.showEmpty();
    await this.runtime.stopAll();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPendingRefresh();
    this.clearPool();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    // Window close (or panel close) stops every container this controller warmed.
    void this.runtime.stopAll();
  }

  private async handleActiveEditorChange(): Promise<void> {
    if (this.disposed) return;

    const file = this.source.activeFilePath();
    if (!file) {
      this.log('[editor] no active file editor → empty');
      this.showEmpty();
      return;
    }

    const folders = this.source.workspaceFolders();
    const target = await this.resolveTarget(file, folders);
    // The editor may have moved on while we resolved; ignore this stale result.
    if (this.disposed || this.source.activeFilePath() !== file) return;

    if (!target) {
      this.log(`[editor] ${file} → not a previewable question → empty`);
      this.showEmpty();
      return;
    }
    if (sameTarget(this.currentTarget, target)) {
      // Already previewing this question (e.g. switching between its files);
      // keep the render and any pending save-refresh intact.
      this.log(`[editor] ${file} → already previewing ${target.qid}; keeping it`);
      return;
    }

    this.log(`[editor] ${file} → previewing ${target.qid}`);
    this.cancelPendingRefresh();
    this.currentTarget = target;
    // Name the tab after the question (its info.json title, or the qid as a
    // fallback), so it reads "<question> (Preview)" instead of a generic title.
    this.sink.setTitle(previewPanelTitle(target.title ?? target.qid));
    await this.render(target, { showStarting: true });
  }

  private handleSave(savedPath: string): void {
    if (this.disposed) {
      this.log(`[save] ${savedPath} ignored: controller disposed`);
      return;
    }
    if (!this.currentTarget) {
      this.log(`[save] ${savedPath} ignored: nothing is being previewed`);
      return;
    }
    const target = this.currentTarget;
    this.log(`[save] ${savedPath} → refresh ${target.qid} in ${this.debounceMs}ms`);
    this.cancelPendingRefresh();
    this.pendingRefresh = this.clock.schedule(this.debounceMs, () => {
      this.pendingRefresh = undefined;
      this.log(`[save] debounce elapsed → re-rendering ${target.qid}`);
      void this.render(target, { showStarting: false });
    });
  }

  private async render(target: PreviewTarget, options: { showStarting: boolean }): Promise<void> {
    const token = ++this.renderToken;

    // A non-v3/Freeform question can't be rendered: show a friendly state instead
    // of a starting flash or a generic error page, and never start a container.
    if (!isPreviewableType(target.type)) {
      this.log(`[render] ${target.qid}: not previewable (type=${target.type ?? ''})`);
      this.sink.setState({ kind: 'notPreviewable', type: target.type ?? '' });
      return;
    }

    // A cold start shows the overview; a course whose container is already warm
    // renders straight through, so switching back to it never flashes "Starting…".
    const warm = this.warm.has(target.courseRoot);
    const coldStart = options.showStarting && !warm;
    if (coldStart) {
      this.sink.setState({ kind: 'starting' });
    }
    this.log(`[render] ${target.qid}: ensuring container (warm=${warm}, token=${token})`);

    // Forward cold-start progress into the "Starting preview…" overview, guarded by
    // the render token so a superseded start's late ticks can't paint over newer
    // state. A warm re-preview shows no overview, so it reports nothing.
    const onProgress = coldStart
      ? (progress: PreviewStartupProgress) => {
          if (this.disposed || token !== this.renderToken) return;
          this.sink.setState({ kind: 'starting', progress });
        }
      : undefined;

    let port: number;
    try {
      ({ port } = await this.runtime.ensureRunning(target.courseRoot, onProgress));
    } catch (error) {
      // A superseded render (editor switched, refresh, or dispose) must not paint
      // its stale failure over the newer state.
      if (this.disposed || token !== this.renderToken) {
        this.log(`[render] ${target.qid}: launch failed but superseded (token ${token}≠${this.renderToken}); dropped`);
        return;
      }
      this.log(`[render] ${target.qid}: launch failed: ${describeError(error)}`);
      this.sink.setState({ kind: 'error', message: describeError(error) });
      return;
    }

    // Superseded by a newer render (editor switched, refresh, or dispose)?
    if (this.disposed || token !== this.renderToken) {
      this.log(`[render] ${target.qid}: superseded after container ready (token ${token}≠${this.renderToken}); dropped`);
      return;
    }

    // The container is up: record the course as most-recently-used, (re)arm its
    // idle-reaper, and evict the least-recently-used course past the pool cap.
    this.markWarm(target.courseRoot);

    const variant = this.seedFor(target);
    const url = buildPreviewUrl({ port, qid: target.qid, variant });
    this.log(`[render] ${target.qid}: showing preview ${url}`);
    this.sink.setState({ kind: 'preview', url, variant });
  }

  /** The question's stable seed, or the default when it has never been rerolled. */
  private seedFor(target: PreviewTarget): string {
    return this.seeds.get(targetKey(target)) ?? DEFAULT_VARIANT;
  }

  /**
   * Record `courseRoot` as most-recently-used, (re)arm its idle-reaper, and evict
   * the least-recently-used course once the pool exceeds the cap. Deleting before
   * re-inserting moves the course to the end of the Map's LRU→MRU order.
   */
  private markWarm(courseRoot: string): void {
    this.warm.get(courseRoot)?.reap.dispose();
    this.warm.delete(courseRoot);
    this.warm.set(courseRoot, { reap: this.scheduleReap(courseRoot) });
    this.evictBeyondCap();
  }

  /** Arm the idle-reaper that stops `courseRoot` if it goes untouched for the TTL. */
  private scheduleReap(courseRoot: string): Disposable {
    return this.clock.schedule(this.idleTtlMs, () => this.reap(courseRoot));
  }

  /** Evict the least-recently-used courses until the pool is back within the cap. */
  private evictBeyondCap(): void {
    while (this.warm.size > this.poolCap) {
      // The first key is the least-recently-used course; the one we just marked
      // sits at the end, so eviction never targets the course being previewed.
      const lru = this.warm.keys().next().value as string;
      this.evict(lru);
    }
  }

  /**
   * Idle-reaper callback: stop a course left untouched for the whole TTL. The
   * course backing the on-screen preview is still in use, so it is kept warm and
   * its idle window re-armed rather than pulled out from under the author.
   */
  private reap(courseRoot: string): void {
    if (this.disposed) return;
    if (courseRoot === this.currentTarget?.courseRoot) {
      const entry = this.warm.get(courseRoot);
      if (entry) {
        entry.reap.dispose();
        entry.reap = this.scheduleReap(courseRoot);
      }
      return;
    }
    this.evict(courseRoot);
  }

  /** Stop a course's container and drop it from the pool (LRU eviction or reaping). */
  private evict(courseRoot: string): void {
    const entry = this.warm.get(courseRoot);
    if (!entry) return;
    entry.reap.dispose();
    this.warm.delete(courseRoot);
    void this.runtime.stop(courseRoot);
  }

  /** Cancel every idle-reaper and forget the warm pool (leaves containers to the caller). */
  private clearPool(): void {
    for (const entry of this.warm.values()) entry.reap.dispose();
    this.warm.clear();
  }

  private showEmpty(): void {
    this.cancelPendingRefresh();
    this.currentTarget = undefined;
    // Invalidate any in-flight render so a late container start can't paint over
    // the empty state.
    this.renderToken += 1;
    // Nothing is being previewed, so drop the question name back to the default.
    this.sink.setTitle(previewPanelTitle(undefined));
    this.sink.setState({ kind: 'empty' });
  }

  private cancelPendingRefresh(): void {
    this.pendingRefresh?.dispose();
    this.pendingRefresh = undefined;
  }
}

/** A warm course's pool entry: its cancellable idle-reaper timer. */
interface WarmEntry {
  reap: Disposable;
}

function sameTarget(a: PreviewTarget | undefined, b: PreviewTarget): boolean {
  return a !== undefined && a.courseRoot === b.courseRoot && a.qid === b.qid;
}

/** A short human summary of a render/launch failure for the error view state. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text === '[object Object]' || text.length === 0 ? 'Preview failed to start.' : text;
}

/** Stable per-question key for the variant-seed map. NUL can't appear in a path. */
function targetKey(target: PreviewTarget): string {
  return `${target.courseRoot} ${target.qid}`;
}
