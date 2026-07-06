import { type Disposable, type EditorWorkspaceSource } from './previewController';
import { type PreviewTarget, resolvePreviewTarget } from './previewTarget';

/**
 * Keep a context key in sync with whether the active file is a previewable
 * PrairieLearn question, so the manifest can show a click-to-preview icon on
 * question files (like the built-in Markdown/HTML preview icon) instead of
 * requiring the "Open Preview" command.
 *
 * Previewability isn't something a static `when` clause can express — it depends
 * on the file living under a course's `questions/<qid>/` tree, which means
 * stat-ing `infoCourse.json` / `info.json`. So this watcher runs the same
 * resolution the {@link PreviewController} uses and publishes the result as a
 * boolean the shell maps to a `setContext` key. It is always-on (wired from
 * activation) and independent of whether the preview panel is open.
 */

/** The context key the manifest's `editor/title` `when` clause gates the icon on. */
export const PREVIEWABLE_CONTEXT_KEY = 'plPreview.activeFileIsPreviewable';

/**
 * The subset of the preview's editor source this watcher needs: the active file,
 * the workspace folders, and the active-editor change signal.
 *
 * Reusing {@link EditorWorkspaceSource} means the same VSCode adapter feeds the
 * watcher and the controller — including its deliberate choice to *ignore*
 * transitions to a non-file editor or none. That keeps the icon steady while the
 * author clicks into the preview webview or the Output channel, rather than
 * flickering off every time focus leaves the question file.
 */
export type ActiveEditorSource = Pick<
  EditorWorkspaceSource,
  'activeFilePath' | 'workspaceFolders' | 'onDidChangeActiveEditor'
>;

/** Receives whether the active file can be previewed; the shell maps it to a context key. */
export interface PreviewabilitySink {
  setCanPreview(canPreview: boolean): void;
}

export interface PreviewabilityWatcherDeps {
  readonly source: ActiveEditorSource;
  readonly sink: PreviewabilitySink;
  /** Preview-target resolver; defaults to the real filesystem resolver. */
  readonly resolveTarget?: (
    activeFilePath: string,
    workspaceFolders: readonly string[],
  ) => Promise<PreviewTarget | null>;
}

/**
 * Watches the active editor and publishes whether its file is a previewable PL
 * question, so the editor-title preview icon shows exactly on question files.
 *
 * Resolution is async (it stats course/question markers), so a monotonic token
 * discards a stale result if the author switches editors again mid-resolve — the
 * key always reflects the *current* active file, never a slower earlier one.
 */
export class PreviewabilityWatcher {
  private readonly source: ActiveEditorSource;
  private readonly sink: PreviewabilitySink;
  private readonly resolveTarget: (
    activeFilePath: string,
    workspaceFolders: readonly string[],
  ) => Promise<PreviewTarget | null>;
  private readonly subscription: Disposable;
  /** Monotonic token; a resolution whose token is stale on settle is discarded. */
  private token = 0;
  private disposed = false;

  constructor(deps: PreviewabilityWatcherDeps) {
    this.source = deps.source;
    this.sink = deps.sink;
    this.resolveTarget = deps.resolveTarget ?? resolvePreviewTarget;
    this.subscription = this.source.onDidChangeActiveEditor(() => this.refresh());
  }

  /**
   * Re-evaluate the current active file and publish whether it can be previewed.
   * Call once after construction to seed the key for a question file that is
   * already open, and again whenever the workspace folders change.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const token = ++this.token;

    const file = this.source.activeFilePath();
    if (!file) {
      this.publish(token, false);
      return;
    }

    const target = await this.resolveTarget(file, this.source.workspaceFolders());
    this.publish(token, target !== null);
  }

  /** Publish a result unless a newer refresh (or dispose) has superseded it. */
  private publish(token: number, canPreview: boolean): void {
    if (this.disposed || token !== this.token) return;
    this.sink.setCanPreview(canPreview);
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
  }
}
