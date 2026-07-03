import * as vscode from 'vscode';

import { dockerRemediation } from './dockerDetection';
import { DockerPreviewRuntime } from './dockerRuntime';
import {
  NEW_VARIANT_COMMAND,
  OPEN_PREVIEW_COMMAND,
  PREVIEW_PANEL_TITLE,
  PREVIEW_VIEW_TYPE,
  REFRESH_PREVIEW_COMMAND,
  SHOW_LOGS_COMMAND,
  STOP_SERVERS_COMMAND,
  emptyPanelHtml,
  errorPanelHtml,
  notPreviewablePanelHtml,
  previewPanelHtml,
  startingPanelHtml,
} from './panel';
import {
  type Clock,
  type Disposable,
  type EditorWorkspaceSource,
  PreviewController,
  type PreviewViewSink,
  type PreviewViewState,
} from './previewController';
import { PREVIEWABLE_CONTEXT_KEY, PreviewabilityWatcher } from './previewability';
import { describeStartupProgress } from './startupProgress';

/**
 * Activation glue (thin shell): adapts VSCode's editor/save events, webview
 * panel, and Docker runtime to the `PreviewController`'s ports, then lets the
 * controller drive the editor-following preview. All load-bearing behavior lives
 * in the controller (unit-tested); this file is the imperative shell verified by
 * driving the extension. The Stable Preview Variant toolbar + New variant
 * command and the render-diagnostics states — `notPreviewable` / `error` plus
 * the `Show logs` Output-channel action — are wired here, as is the guided
 * first-run Docker detection + pinned-image pull-with-progress. The always-on
 * {@link PreviewabilityWatcher} that lights the editor-title preview icon on
 * question files is wired here too.
 */

let panel: vscode.WebviewPanel | undefined;
let controller: PreviewController | undefined;
let runtime: DockerPreviewRuntime | undefined;
let output: vscode.OutputChannel | undefined;

/** Adapts VSCode's active-editor and save events to the controller's source port. */
class VscodeEditorWorkspaceSource implements EditorWorkspaceSource {
  activeFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    return editor.document.uri.fsPath;
  }

  workspaceFolders(): readonly string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  }

  onDidChangeActiveEditor(listener: () => void | Promise<void>): Disposable {
    return vscode.window.onDidChangeActiveTextEditor((editor) => {
      // VSCode reports `undefined` when focus moves to a non-text editor (our
      // webview, the Output channel). Ignore those so the preview persists while
      // the author interacts with it, and only follow real file editors.
      if (editor && editor.document.uri.scheme === 'file') {
        void listener();
      }
    });
  }

  onDidSaveDocument(listener: (savedPath: string) => void): Disposable {
    return vscode.workspace.onDidSaveTextDocument((document) => {
      // Log every save the editor reports (even non-`file` ones we drop) so a
      // "save didn't refresh" report can be traced from the very first event.
      getOutput().appendLine(
        `[event] onDidSaveTextDocument (${document.uri.scheme}) ${document.uri.fsPath}`,
      );
      if (document.uri.scheme === 'file') {
        listener(document.uri.fsPath);
      }
    });
  }
}

/** Real-time clock with cancellable scheduling for the save-debounce. */
class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  schedule(delayMs: number, callback: () => void): Disposable {
    const handle = setTimeout(callback, delayMs);
    return { dispose: () => clearTimeout(handle) };
  }
}

/** Renders controller view states into the webview panel (the sink port). */
class WebviewPreviewSink implements PreviewViewSink {
  /**
   * Monotonic nonce appended to the iframe URL on every `preview` render. A
   * save-refresh re-renders the same question at the same loopback URL; a
   * byte-identical `src` would not re-fetch, so the edit would never appear.
   * Bumping this guarantees a distinct `src` each render, forcing a fresh GET the
   * preview server re-renders — whether that `src` arrives as new HTML or an
   * in-place update message.
   */
  private reloadNonce = 0;

  /**
   * Loopback port of the container behind the currently mounted preview document,
   * or `undefined` when the panel shows a non-preview state. A re-render for this
   * same port updates the iframe in place (via a message) instead of reassigning
   * `webview.html`, which would reload the whole panel — toolbar included — and
   * flash. A different port is a different container, so the CSP `frame-src` and
   * port mapping baked into the HTML must be rebuilt.
   */
  private previewPort: number | undefined;

  /**
   * Whether the live "Starting preview…" overview doc is currently mounted. While
   * it is, subsequent `starting` states update it in place via `postMessage`
   * (mirroring the {@link previewPort} in-place optimization) rather than remounting
   * — a full remount per download tick would flash and restart the CSS animation.
   * Reset whenever any other document is mounted (see {@link showDocument} and the
   * `preview` rebuild branch).
   */
  private showingStarting = false;

  constructor(
    private readonly view: vscode.WebviewPanel,
    /** The container-log channel revealed by the error state's "Show logs" action. */
    private readonly output: vscode.OutputChannel,
  ) {}

  setTitle(title: string): void {
    this.view.title = title;
  }

  setState(state: PreviewViewState): void {
    switch (state.kind) {
      case 'empty':
        this.showDocument(emptyPanelHtml());
        return;
      case 'starting': {
        // First frame mounts the live overview; later ticks update it in place so
        // an in-flight download never remounts (which would flash and reset the bar).
        if (this.showingStarting) {
          void this.view.webview.postMessage({
            type: 'progress',
            ...describeStartupProgress(state.progress),
          });
          return;
        }
        this.showDocument(startingPanelHtml(state.progress));
        this.showingStarting = true;
        return;
      }
      case 'notPreviewable':
        this.showDocument(notPreviewablePanelHtml(state.type));
        return;
      case 'error':
        this.showDocument(errorPanelHtml(state.message));
        // Fail loudly with a one-click path to the traceback in the Output channel.
        void vscode.window
          .showErrorMessage(`PL Preview: ${state.message}`, 'Show logs')
          .then((choice) => {
            if (choice === 'Show logs') this.output.show(true);
          });
        return;
      case 'preview': {
        const url = new URL(state.url);
        const port = Number(url.port);
        // Cache-bust so a save-refresh at the same URL still reloads the iframe;
        // the preview server ignores this unknown param (only `variant` matters).
        url.searchParams.set('__plReload', String(++this.reloadNonce));
        const src = url.toString();
        // Same container as the mounted preview? Swap the iframe in place with a
        // message — reassigning webview.html would reload the whole panel and
        // flash. Only a new port needs a fresh document (new frame-src / mapping).
        if (this.previewPort === port) {
          void this.view.webview.postMessage({ type: 'render', src, variant: state.variant });
          return;
        }
        this.previewPort = port;
        // Leaving the live overview: this rebuild bypasses showDocument, so clear
        // the flag here too or the next starting tick would post into this doc.
        this.showingStarting = false;
        // Forward the container's loopback port through the webview so the iframe
        // can reach it (the CSP frame-src in previewPanelHtml permits that origin).
        this.view.webview.options = {
          enableScripts: true,
          portMapping: [{ webviewPort: port, extensionHostPort: port }],
        };
        this.view.webview.html = previewPanelHtml({ src, variant: state.variant });
        return;
      }
    }
  }

  /**
   * Mount a non-preview document (empty / starting / notPreviewable / error),
   * dropping the mounted-preview marker so the next `preview` render rebuilds the
   * HTML fresh rather than messaging a document that is no longer there.
   */
  private showDocument(html: string): void {
    this.previewPort = undefined;
    this.showingStarting = false;
    this.view.webview.options = { enableScripts: true };
    this.view.webview.html = html;
  }
}

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    PREVIEW_VIEW_TYPE,
    PREVIEW_PANEL_TITLE,
    { preserveFocus: true, viewColumn: vscode.ViewColumn.Beside },
    { enableScripts: true, retainContextWhenHidden: true },
  );

  // The rendered-question toolbar's "New variant" button posts back here; reroll
  // through the controller, the same path as the Command Palette command.
  panel.webview.onDidReceiveMessage(
    (message: { type?: string } | undefined) => {
      if (message?.type === 'newVariant') {
        void controller?.newVariant();
      }
    },
    null,
    context.subscriptions,
  );

  panel.onDidDispose(
    () => {
      panel = undefined;
      controller?.dispose();
      controller = undefined;
    },
    null,
    context.subscriptions,
  );

  return panel;
}

function getRuntime(): DockerPreviewRuntime {
  if (!runtime) {
    // First-use pull and readiness progress are surfaced in the panel's live
    // "Starting preview…" overview (via the controller's onProgress), so the runtime
    // only needs the Output-channel log sink here — no separate progress notification.
    runtime = new DockerPreviewRuntime({
      log: (line) => getOutput().appendLine(line),
    });
  }
  return runtime;
}

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('PL Preview');
  }
  return output;
}

async function openPreview(context: vscode.ExtensionContext): Promise<void> {
  // Before opening a panel or launching a container, make sure the Docker daemon
  // is reachable. If it isn't, show an actionable install/start message and stop
  // before any cryptic socket error can reach the author.
  if (!(await ensureDockerReady())) {
    return;
  }

  const view = ensurePanel(context);

  if (!controller) {
    controller = new PreviewController({
      source: new VscodeEditorWorkspaceSource(),
      runtime: getRuntime(),
      clock: new SystemClock(),
      sink: new WebviewPreviewSink(view, getOutput()),
      log: (line) => getOutput().appendLine(line),
    });
  }

  // Render whatever the active editor currently points at; the controller then
  // follows the editor and refreshes on save until the panel is disposed.
  await controller.start();
}

/**
 * Detect a reachable Docker daemon. Returns `true` to proceed; on a missing /
 * stopped / unreachable daemon it shows the actionable remediation (opening the
 * install docs if the author chooses) and returns `false` so the caller stops.
 */
async function ensureDockerReady(): Promise<boolean> {
  const availability = await getRuntime().checkAvailability();
  const remediation = dockerRemediation(availability);
  if (!remediation) {
    return true;
  }

  const actions = remediation.action ? [remediation.action] : [];
  const choice = await vscode.window.showErrorMessage(
    `PL Preview: ${remediation.message}`,
    ...actions,
  );
  if (choice && choice === remediation.action && remediation.url) {
    void vscode.env.openExternal(vscode.Uri.parse(remediation.url));
  }
  return false;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PREVIEW_COMMAND, () => openPreview(context)),
    vscode.commands.registerCommand(REFRESH_PREVIEW_COMMAND, () => controller?.refresh()),
    vscode.commands.registerCommand(NEW_VARIANT_COMMAND, () => controller?.newVariant()),
    // "Show logs": reveal the container's stdout/stderr Output channel on demand.
    vscode.commands.registerCommand(SHOW_LOGS_COMMAND, () => getOutput().show(true)),
    // "Stop preview servers": stop every warm container to reclaim resources.
    vscode.commands.registerCommand(STOP_SERVERS_COMMAND, () => controller?.stopServers()),
  );

  watchPreviewability(context);
}

/**
 * Keep the editor-title preview icon in sync with the active file: a light,
 * always-on watcher resolves whether the active editor is a previewable question
 * and publishes a context key the manifest gates the icon on — no container, no
 * panel, just a filesystem stat per editor switch. Seeded once for a question
 * file already open at activation, and re-run when the workspace folders change.
 */
function watchPreviewability(context: vscode.ExtensionContext): void {
  const watcher = new PreviewabilityWatcher({
    source: new VscodeEditorWorkspaceSource(),
    sink: {
      setCanPreview: (canPreview) => {
        void vscode.commands.executeCommand('setContext', PREVIEWABLE_CONTEXT_KEY, canPreview);
      },
    },
  });
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void watcher.refresh();
    }),
  );
  void watcher.refresh();
}

export async function deactivate(): Promise<void> {
  controller?.dispose();
  controller = undefined;
  panel?.dispose();
  panel = undefined;
  await runtime?.stopAll();
  runtime = undefined;
  output?.dispose();
  output = undefined;
}
