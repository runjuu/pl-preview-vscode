import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import * as vscode from 'vscode';

import {
  type RemovablePreviewImage,
  formatBytes,
  resolvePreviewImage,
} from './containerSpec';
import { DockerPreviewRuntime, type PreviewWorkspaceSupport } from './dockerRuntime';
import {
  DELETE_OLD_IMAGES_COMMAND,
  NEW_VARIANT_COMMAND,
  OPEN_PREVIEW_COMMAND,
  PREVIEW_PANEL_TITLE,
  PREVIEW_VIEW_TYPE,
  REFRESH_PREVIEW_COMMAND,
  SHOW_LOGS_COMMAND,
  STOP_SERVERS_COMMAND,
  WORKSPACE_VIEW_TYPE,
  emptyPanelHtml,
  errorPanelHtml,
  notPreviewablePanelHtml,
  previewPanelHtml,
  startingPanelHtml,
  workspacePanelHtml,
  workspacePanelTitle,
} from './panel';
import {
  type Clock,
  type Disposable,
  type EditorWorkspaceSource,
  PreviewController,
  type PreviewViewSink,
  type PreviewViewState,
} from './previewController';
import { PreviewProxy } from './previewProxy';
import { PREVIEWABLE_CONTEXT_KEY, PreviewabilityWatcher } from './previewability';
import {
  type RuntimeAvailability,
  classifyRuntimeProbe,
  detectCli,
  runtimeRemediation,
} from './runtimeDetection';
import {
  type ContainerRuntimeProfile,
  type EndpointContext,
  type RuntimeEndpoint,
  type RuntimeStartAction,
  dockerodeOptionsForEndpoint,
} from './runtimeProfiles';
import {
  type RuntimeCandidate,
  type RuntimeConfig,
  resolveRuntimeSelection,
} from './runtimeResolution';
import { describeStartupProgress } from './startupProgress';

/**
 * Activation glue (thin shell): adapts VSCode's editor/save events, webview
 * panel, and container runtime to the `PreviewController`'s ports, then lets the
 * controller drive the editor-following preview. All load-bearing behavior lives
 * in the controller (unit-tested); this file is the imperative shell verified by
 * driving the extension. The Stable Preview Variant toolbar + New variant
 * command and the render-diagnostics states — `notPreviewable` / `error` plus
 * the `Show logs` Output-channel action — are wired here, as is the guided
 * first-run runtime detection: it resolves a Docker-Engine-API-compatible runtime
 * (Docker or Podman, auto-detected or chosen via `plPreview.containerRuntime` /
 * `plPreview.containerHost`) and, when one is installed but stopped, offers a
 * "Start …" action that launches it and waits — plus pinned-image
 * pull-with-progress. The always-on {@link PreviewabilityWatcher} that lights the
 * editor-title preview icon on question files is wired here too.
 */

let panel: vscode.WebviewPanel | undefined;
const workspacePanels = new Map<string, vscode.WebviewPanel>();
let controller: PreviewController | undefined;
let previewSink: WebviewPreviewSink | undefined;
let runtime: DockerPreviewRuntime | undefined;
/** The runtime profile + endpoint bound this session, so remediation can be tailored. */
let selectedProfile: ContainerRuntimeProfile | undefined;
let selectedEndpoint: RuntimeEndpoint | undefined;
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
   * Local reverse proxies, keyed by the real preview-server port they front.
   * Values are startup promises so concurrent renders for the same port cannot
   * create competing proxy servers.
   */
  private readonly proxies = new Map<number, Promise<PreviewProxy>>();

  /**
   * Loopback port of the container behind the currently mounted preview document,
   * or `undefined` when the panel shows a non-preview state. A re-render for this
   * same port updates the iframe in place (via a message) instead of reassigning
   * `webview.html`, which would reload the whole panel — toolbar included — and
   * flash. A different port is a different container, so the CSP `frame-src` and
   * port mapping baked into the HTML must be rebuilt.
   */
  private previewPort: number | undefined;

  /** Cancels stale async proxy starts when a newer render wins the panel. */
  private renderToken = 0;

  /** Per-mounted preview document token for host-to-webview update messages. */
  private previewMessageToken = randomMessageToken();

  /** Token accepted from workspace-link bridge messages injected by the proxy. */
  private readonly workspaceBridgeToken = randomMessageToken();

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
          .showErrorMessage(`PrairieLearn Preview: ${state.message}`, 'Show logs')
          .then((choice) => {
            if (choice === 'Show logs') this.output.show(true);
          });
        return;
      case 'preview':
        void this.showPreview(state);
        return;
    }
  }

  private async showPreview(state: Extract<PreviewViewState, { kind: 'preview' }>): Promise<void> {
    const token = ++this.renderToken;
    const url = new URL(state.url);
    const port = Number(url.port);
    // Cache-bust so a save-refresh at the same URL still reloads the iframe;
    // the preview server ignores this unknown param (only `variant` matters).
    url.searchParams.set('__plReload', String(++this.reloadNonce));
    const targetSrc = url.toString();

    let proxy: PreviewProxy;
    try {
      proxy = await this.ensureProxy(port, url.origin);
    } catch (err) {
      if (token !== this.renderToken) return;
      this.output.appendLine(`[pl-preview] could not start preview proxy: ${formatError(err)}`);
      this.showDocument(errorPanelHtml('Could not start the local preview proxy'));
      return;
    }
    if (token !== this.renderToken) return;

    const src = proxy.urlFor(targetSrc);
    // Same container/proxy as the mounted preview? Swap the iframe in place with a
    // message — reassigning webview.html would reload the whole panel and flash.
    if (this.previewPort === port) {
      void this.view.webview.postMessage({
        type: 'render',
        token: this.previewMessageToken,
        src,
        variant: state.variant,
      });
      return;
    }

    this.previewPort = port;
    this.previewMessageToken = randomMessageToken();
    // Leaving the live overview: this rebuild bypasses showDocument, so clear
    // the flag here too or the next starting tick would post into this doc.
    this.showingStarting = false;
    // Forward the proxy's loopback port through the webview. The proxy then
    // forwards to the real preview server and rewrites workspace links in HTML.
    this.view.webview.options = {
      enableScripts: true,
      portMapping: [{ webviewPort: proxy.port, extensionHostPort: proxy.port }],
    };
    this.view.webview.html = previewPanelHtml({
      hostMessageToken: this.previewMessageToken,
      src,
      variant: state.variant,
      workspaceBridgeToken: this.workspaceBridgeToken,
      workspaceTargetOrigin: url.origin,
    });
  }

  private async ensureProxy(port: number, targetOrigin: string): Promise<PreviewProxy> {
    const existing = this.proxies.get(port);
    if (existing) return existing;

    const proxy = new PreviewProxy({
      log: (line) => this.output.appendLine(line),
      targetOrigin,
      workspaceBridgeToken: this.workspaceBridgeToken,
    });
    const started = proxy
      .start()
      .then(() => proxy)
      .catch((err) => {
        if (this.proxies.get(port) === started) {
          this.proxies.delete(port);
        }
        void proxy.dispose().catch(() => undefined);
        throw err;
      });
    this.proxies.set(port, started);
    return started;
  }

  /**
   * Mount a non-preview document (empty / starting / notPreviewable / error),
   * dropping the mounted-preview marker so the next `preview` render rebuilds the
   * HTML fresh rather than messaging a document that is no longer there.
   */
  private showDocument(html: string): void {
    this.renderToken++;
    this.previewPort = undefined;
    this.showingStarting = false;
    this.view.webview.options = { enableScripts: true };
    this.view.webview.html = html;
  }

  dispose(): void {
    this.renderToken++;
    const proxies = [...this.proxies.values()];
    this.proxies.clear();
    for (const proxy of proxies) {
      void proxy.then((startedProxy) => startedProxy.dispose()).catch(() => undefined);
    }
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

  // The rendered-question toolbar posts back here: "New variant" rerolls through
  // the controller, and "Open workspace" opens the discovered workspace page in
  // its own VS Code tab.
  panel.webview.onDidReceiveMessage(
    (message: { type?: string; url?: string } | undefined) => {
      if (message?.type === 'newVariant') {
        void controller?.newVariant();
        return;
      }
      if (message?.type === 'openWorkspace' && typeof message.url === 'string') {
        // Name the workspace tab after the question that opened it, not its numeric id.
        openWorkspacePanel(context, message.url, controller?.currentQuestionName());
      }
    },
    null,
    context.subscriptions,
  );

  panel.onDidDispose(
    () => {
      panel = undefined;
      disposePreviewSink();
      controller?.dispose();
      controller = undefined;
    },
    null,
    context.subscriptions,
  );

  return panel;
}

function openWorkspacePanel(
  context: vscode.ExtensionContext,
  rawUrl: string,
  questionName?: string,
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    void vscode.window.showErrorMessage('PrairieLearn Preview: Could not open workspace: invalid URL.');
    return;
  }

  if (!isLoopbackWorkspaceUrl(url)) {
    void vscode.window.showErrorMessage('PrairieLearn Preview: Could not open workspace: unexpected URL.');
    return;
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    void vscode.window.showErrorMessage('PrairieLearn Preview: Could not open workspace: missing preview port.');
    return;
  }

  const id = url.pathname.match(/\/workspace\/([^/?#]+)\/?$/)?.[1];
  if (!id) {
    void vscode.window.showErrorMessage('PrairieLearn Preview: Could not open workspace: missing workspace id.');
    return;
  }

  // Open the workspace as a sibling tab in the preview's own column rather than
  // `ViewColumn.Beside`: the preview tab is active when "Open workspace" is
  // clicked, so `Beside` would spawn a third column instead of reusing its space.
  const previewColumn = panel?.viewColumn ?? vscode.ViewColumn.Beside;

  const key = url.toString();
  const existing = workspacePanels.get(key);
  if (existing) {
    existing.reveal(previewColumn, false);
    return;
  }

  const workspacePanel = vscode.window.createWebviewPanel(
    WORKSPACE_VIEW_TYPE,
    workspacePanelTitle(questionName, safeDecodeURIComponent(id)),
    { preserveFocus: false, viewColumn: previewColumn },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: [{ webviewPort: port, extensionHostPort: port }],
    },
  );

  // The control bar (status + Reboot/Reset) posts back here; host→webview status and
  // reload messages carry this token so the webview rejects anything else.
  const origin = url.origin;
  const hostMessageToken = randomMessageToken();
  let reloadNonce = 0;

  workspacePanels.set(key, workspacePanel);
  workspacePanel.webview.html = workspacePanelHtml({ src: key, hostMessageToken });

  workspacePanel.webview.onDidReceiveMessage(
    async (message: { type?: string } | undefined) => {
      const action = message?.type;
      if (action !== 'reboot' && action !== 'reset') return;

      // Confirm natively — the whole reason these controls moved to the host is that the
      // webview suppresses window.confirm(). Reset is destructive (wipes files); Reboot
      // restarts the container but keeps them.
      const confirm =
        action === 'reboot'
          ? {
              detail: 'The container restarts; workspace files are kept but running programs stop.',
              label: 'Reboot',
              title: 'Reboot this workspace?',
            }
          : {
              detail: 'This permanently discards all changes and restores the original files.',
              label: 'Reset',
              title: 'Reset this workspace?',
            };

      const choice = await vscode.window.showWarningMessage(
        confirm.title,
        { detail: confirm.detail, modal: true },
        confirm.label,
      );
      if (choice !== confirm.label) return;

      const ok = await postWorkspaceAction(origin, id, action);
      if (!ok) {
        void vscode.window.showErrorMessage(`PrairieLearn Preview: ${confirm.label} failed.`);
        return;
      }

      // The container URL is stable, so the still-mounted page won't swap containers on
      // its own — reload the workspace page (cache-busted) to pick up the fresh one.
      const reload = new URL(key);
      reload.searchParams.set('__plReload', String(++reloadNonce));
      void workspacePanel.webview.postMessage({
        src: reload.toString(),
        token: hostMessageToken,
        type: 'reload',
      });
    },
    null,
    context.subscriptions,
  );

  // Poll the workspace status so the control bar's dot/label stay live. Plain `/status`
  // is a pure read (no `?heartbeat=1`), so it never extends the workspace's activity
  // window — the inner iframe already sends its own visibility-gated heartbeat.
  const statusTimer = setInterval(() => {
    if (!workspacePanel.visible) return;
    void getWorkspaceStatus(origin, id).then((status) => {
      if (!status) return;
      void workspacePanel.webview.postMessage({
        message: status.message,
        state: status.state,
        token: hostMessageToken,
        type: 'status',
      });
    });
  }, 1000);

  workspacePanel.onDidDispose(
    () => {
      clearInterval(statusTimer);
      workspacePanels.delete(key);
    },
    null,
    context.subscriptions,
  );
}

function isLoopbackWorkspaceUrl(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
    /(^|\/)workspace\/[^/?#]+\/?$/.test(url.pathname)
  );
}

function randomMessageToken(): string {
  return randomBytes(16).toString('hex');
}

const WORKSPACE_ACTION_TIMEOUT_MS = 10000;
const WORKSPACE_STATUS_TIMEOUT_MS = 4000;

/**
 * POST a reboot/reset to the preview server's workspace endpoint over loopback. Resolves
 * true on a 2xx, false on any non-2xx / network error / timeout — the caller surfaces the
 * failure and skips the reload.
 */
function postWorkspaceAction(
  origin: string,
  id: string,
  action: 'reboot' | 'reset',
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `${origin}/workspace/${id}/${action}`,
      { method: 'POST' },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    req.setTimeout(WORKSPACE_ACTION_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * GET the workspace status JSON over loopback for the control-bar poll. Resolves null on
 * any non-200 / parse / network error / timeout, so a transient blip just skips one tick.
 */
function getWorkspaceStatus(
  origin: string,
  id: string,
): Promise<{ message: string; state: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(`${origin}/workspace/${id}/status`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { message?: unknown; state?: unknown };
          if (typeof parsed.state === 'string' && typeof parsed.message === 'string') {
            resolve({ message: parsed.message, state: parsed.state });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(WORKSPACE_STATUS_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The runtime bound this session by {@link ensureRuntimeReady}; must be resolved first. */
function getRuntime(): DockerPreviewRuntime {
  if (!runtime) {
    throw new Error('preview runtime accessed before ensureRuntimeReady resolved one');
  }
  return runtime;
}

/** Read the user's runtime selection from `plPreview.*` settings. */
function readRuntimeConfig(): RuntimeConfig {
  const config = vscode.workspace.getConfiguration('plPreview');
  const setting = config.get<string>('containerRuntime', 'auto');
  const runtime = (['auto', 'docker', 'podman', 'custom'] as const).find((id) => id === setting) ?? 'auto';
  return { runtime, containerHost: config.get<string>('containerHost', '') ?? '' };
}

/** The host facts the pure runtime-resolution logic reads. */
function endpointContext(): EndpointContext {
  return {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    programFiles: process.env.ProgramFiles,
  };
}

/** Ping one candidate's endpoint and classify the outcome — the real probe for resolution. */
async function probeCandidate(candidate: RuntimeCandidate): Promise<RuntimeAvailability> {
  const client = new Docker(dockerodeOptionsForEndpoint(candidate.endpoint));
  try {
    await client.ping();
    return { kind: 'available' };
  } catch (pingError) {
    return classifyRuntimeProbe({ pingError, cliDetected: detectCli(candidate.profile.cliNames) });
  }
}

/**
 * Bind the session to a resolved candidate, building its dockerode-backed runtime.
 * Idempotent for an unchanged endpoint so warm containers survive repeated opens;
 * a changed endpoint only reaches here after a config change disposed the old one.
 */
function buildRuntime(candidate: RuntimeCandidate): void {
  if (runtime && endpointsEqual(selectedEndpoint, candidate.endpoint)) {
    return;
  }
  selectedProfile = candidate.profile;
  selectedEndpoint = candidate.endpoint;
  const { support: workspaces, disabledReason } = computeWorkspaceSupport(candidate.endpoint);
  // First-use pull and readiness progress surface in the panel's live "Starting
  // preview…" overview (via the controller's onProgress), so the runtime only
  // needs the Output-channel log sink here.
  runtime = new DockerPreviewRuntime({
    docker: new Docker(dockerodeOptionsForEndpoint(candidate.endpoint)),
    cliNames: candidate.profile.cliNames,
    log: (line) => getOutput().appendLine(line),
    workspaces,
  });
  getOutput().appendLine(
    `[pl-preview] using ${candidate.profile.displayName} via ${describeEndpoint(candidate.endpoint)}`,
  );
  getOutput().appendLine(
    workspaces == null
      ? `[pl-preview] workspace questions disabled: ${disabledReason}`
      : '[pl-preview] workspace questions enabled for this trusted workspace',
  );
}

/**
 * Decide whether preview containers get workspace-question support this session.
 * Enabling it mounts the runtime socket into the preview container (host-root
 * equivalent with a rootful daemon), so it is gated on an explicitly trusted
 * workspace and a socket endpoint we can actually bind-mount (podman-machine /
 * remote tcp/ssh endpoints have no local socket).
 *
 * Windows is supported: the workspace home dirs live in a daemon-managed named
 * volume (not a host path), and the runtime socket is bound from its real Unix
 * path inside the Docker Desktop VM (`/var/run/docker.sock`) even though the
 * dockerode client reaches the daemon over the `//./pipe/docker_engine` named
 * pipe — so neither the drive-letter host path nor the named pipe leaks into a
 * bind mount. The named-pipe endpoint still classifies as a `socket` endpoint.
 *
 * Returns the support config when enabled, or a short human `disabledReason`
 * naming the specific gate that failed — the Output channel echoes it verbatim,
 * so it must read well after "workspace questions disabled: ".
 */
function computeWorkspaceSupport(endpoint: RuntimeEndpoint): WorkspaceSupportDecision {
  if (!vscode.workspace.isTrusted) {
    return { disabledReason: 'this workspace is not trusted' };
  }
  if (endpoint.kind !== 'socket') {
    return { disabledReason: 'the container runtime is not reachable over a local socket' };
  }
  if (!vscode.workspace.getConfiguration('plPreview').get<boolean>('enableWorkspaces', true)) {
    return { disabledReason: 'turned off via the plPreview.enableWorkspaces setting' };
  }
  return {
    support: {
      dockerSocketPath: endpoint.socketPath,
      socketGid: socketGroupId(endpoint.socketPath),
    },
  };
}

/**
 * Outcome of {@link computeWorkspaceSupport}: exactly one field is set — `support`
 * when workspace questions are enabled this session, or `disabledReason` (a short
 * human phrase for the Output channel) when they are not.
 */
interface WorkspaceSupportDecision {
  readonly support?: PreviewWorkspaceSupport;
  readonly disabledReason?: string;
}

/**
 * The supplementary gid the non-root container user needs to open the mounted
 * socket. VM-backed runtimes (Docker Desktop, and the Lima/WSL2-based engines on
 * macOS/Windows) re-present the bind-mounted socket as `root:root` mode 0660
 * inside the guest — regardless of who owns it on the host — so the container
 * user must join group 0 to open it; the host-side gid means nothing there. On
 * native Linux the bind mount preserves the socket's real ownership instead
 * (a rootful daemon's socket is `root:docker`), so we grant that gid.
 */
function socketGroupId(socketPath: string): number | undefined {
  if (process.platform !== 'linux') {
    return 0;
  }
  try {
    return fs.statSync(socketPath).gid;
  } catch {
    return undefined;
  }
}

/** Whether two endpoints address the same daemon. */
function endpointsEqual(a: RuntimeEndpoint | undefined, b: RuntimeEndpoint): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'socket' && b.kind === 'socket') return a.socketPath === b.socketPath;
  if (a.kind === 'tcp' && b.kind === 'tcp') {
    return a.host === b.host && a.port === b.port && a.protocol === b.protocol;
  }
  if (a.kind === 'ssh' && b.kind === 'ssh') {
    return a.host === b.host && a.port === b.port && a.username === b.username;
  }
  return false;
}

/** A short, human label for an endpoint (Output channel / diagnostics). */
function describeEndpoint(endpoint: RuntimeEndpoint): string {
  switch (endpoint.kind) {
    case 'socket':
      return endpoint.socketPath;
    case 'tcp':
      return `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`;
    case 'ssh':
      return `ssh://${endpoint.host}:${endpoint.port}`;
  }
}

/** Drop the current runtime (stopping its containers) so the next open re-resolves. */
async function resetRuntime(): Promise<void> {
  disposePreviewSink();
  controller?.dispose();
  controller = undefined;
  const previous = runtime;
  runtime = undefined;
  selectedProfile = undefined;
  selectedEndpoint = undefined;
  await previous?.stopAll();
}

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('PrairieLearn Preview');
  }
  return output;
}

async function openPreview(context: vscode.ExtensionContext): Promise<void> {
  // Before opening a panel or launching a container, resolve and reach a container
  // runtime. If none is reachable, show an actionable install/start message and
  // stop before any cryptic socket error can reach the author.
  if (!(await ensureRuntimeReady())) {
    return;
  }

  const view = ensurePanel(context);

  if (!controller) {
    previewSink = new WebviewPreviewSink(view, getOutput());
    controller = new PreviewController({
      source: new VscodeEditorWorkspaceSource(),
      runtime: getRuntime(),
      clock: new SystemClock(),
      sink: previewSink,
      log: (line) => getOutput().appendLine(line),
    });
  }

  // Render whatever the active editor currently points at; the controller then
  // follows the editor and refreshes on save until the panel is disposed.
  await controller.start();
}

/** How long to wait for a just-launched runtime to accept connections (Podman VM boots are slow). */
const RUNTIME_START_TIMEOUT_MS = 120_000;
/** How often to re-probe the daemon while waiting for the runtime to start. */
const RUNTIME_START_POLL_INTERVAL_MS = 2_000;
/** Briefly watch a GUI-app launch for an immediate missing-app / non-zero failure. */
const RUNTIME_LAUNCH_FAILURE_GRACE_MS = 1_500;

/**
 * Resolve and reach a container runtime. Returns `true` to proceed. Once a runtime
 * is bound this session, it is only re-verified (so warm containers persist);
 * otherwise the configured selection is resolved and the first reachable endpoint
 * is bound. On a missing / stopped / unreachable runtime it shows the actionable
 * remediation and returns `false` — except when the author clicks "Start …", where
 * we launch the runtime, wait for its daemon, and return `true` to continue.
 */
async function ensureRuntimeReady(): Promise<boolean> {
  const ctx = endpointContext();

  // Already bound this session: just re-verify the same endpoint is still up.
  if (runtime && selectedProfile && selectedEndpoint) {
    const availability = await runtime.checkAvailability();
    if (availability.kind === 'available') {
      return true;
    }
    const candidate: RuntimeCandidate = {
      profile: selectedProfile,
      endpoint: selectedEndpoint,
      source: 'wellKnown',
    };
    return handleUnavailable({ candidate, availability }, ctx);
  }

  const selection = await resolveRuntimeSelection(readRuntimeConfig(), ctx, probeCandidate);
  switch (selection.kind) {
    case 'available':
      buildRuntime(selection.candidate);
      return true;
    case 'configError':
      void vscode.window.showErrorMessage(`PrairieLearn Preview: ${selection.message}`);
      return false;
    case 'unavailable':
      return handleUnavailable(selection, ctx);
  }
}

/**
 * Show the actionable remediation for an unreachable runtime and, when the author
 * accepts, drive it. A `custom` endpoint has no known install/start path, so it is
 * pointed back at the setting; Docker/Podman get their tailored install-URL or
 * "Start …" action (the latter only surfaced where we know how to start it).
 */
async function handleUnavailable(
  selection: { readonly candidate: RuntimeCandidate; readonly availability: RuntimeAvailability },
  ctx: EndpointContext,
): Promise<boolean> {
  const { candidate, availability } = selection;
  const profile = candidate.profile;

  if (profile.id === 'custom') {
    void vscode.window.showErrorMessage(
      `PrairieLearn Preview: Could not reach the container runtime at ${describeEndpoint(candidate.endpoint)}. Check the "plPreview.containerHost" setting, then run the preview again.`,
    );
    return false;
  }

  const start = profile.startAction(ctx);
  const remediation = runtimeRemediation(availability, profile, start?.label);
  if (!remediation) {
    return true;
  }

  const action = remediation.action;
  // The "Start …" button only appears where we can actually start the runtime
  // (and, for an absolute app path, where its executable exists); otherwise the
  // notification falls back to its manual start guidance.
  const launch = action?.kind === 'startRuntime' && start ? resolveRuntimeStart(start) : undefined;
  const showButton = action?.kind === 'openUrl' || (action?.kind === 'startRuntime' && launch);
  const buttons = showButton && action ? [action.label] : [];

  const choice = await vscode.window.showErrorMessage(`PrairieLearn Preview: ${remediation.message}`, ...buttons);
  if (!action || choice !== action.label) {
    return false;
  }

  switch (action.kind) {
    case 'openUrl':
      void vscode.env.openExternal(vscode.Uri.parse(action.url));
      return false;
    case 'startRuntime':
      // `launch` is defined here: the button only rendered once it resolved.
      return launch ? launchRuntimeAndWait(launch, candidate) : false;
  }
}

/**
 * The runtime's start action for this machine, or `undefined` when we can't
 * reliably run it. For an absolute app path (Docker Desktop.exe) we require the
 * executable to exist, so a resolved action always spawns something real; CLI
 * commands on PATH (`open`, `podman`, `systemctl`) are trusted.
 */
function resolveRuntimeStart(action: RuntimeStartAction): RuntimeStartAction | undefined {
  if (path.isAbsolute(action.command) && !fs.existsSync(action.command)) return undefined;
  return action;
}

/**
 * Run the runtime's start action, then poll its endpoint behind a cancellable
 * progress notification until it answers. Returns `true` once the runtime is
 * reachable (binding it for the session) so the caller continues into the
 * preview, or `false` if the author cancels, the launch fails, or it doesn't come
 * up in time (with a nudge to retry).
 */
async function launchRuntimeAndWait(action: RuntimeStartAction, candidate: RuntimeCandidate): Promise<boolean> {
  const launched = await startRuntimeProcess(action);
  if (!launched.ok) {
    getOutput().appendLine(`[pl-preview] could not run "${action.label}": ${launched.detail}`);
    void vscode.window
      .showErrorMessage(
        `PrairieLearn Preview: Could not run "${action.label}". Start ${candidate.profile.displayName} manually, then run the preview again.`,
        'Show logs',
      )
      .then((choice) => {
        if (choice === 'Show logs') getOutput().show(true);
      });
    return false;
  }

  return waitForRuntimeAfterLaunch(candidate);
}

type RuntimeLaunchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * Spawn the runtime's start action. Two shapes, per {@link RuntimeStartAction.mode}:
 * `launchApp` fires a GUI app that keeps running (exit 0, or a short grace window,
 * means "launched"); `runToCompletion` is a CLI command we let finish and treat
 * *any* exit as "done trying" — a non-zero "machine already running" is fine
 * because the daemon poll that follows is the real source of truth. Only a spawn
 * error (e.g. the CLI is missing) is a hard failure.
 */
function startRuntimeProcess(action: RuntimeStartAction): Promise<RuntimeLaunchResult> {
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (result: RuntimeLaunchResult) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };

    try {
      // Detached + unref'd so the launched app/command never tethers the editor's lifetime.
      const child = spawn(action.command, [...action.args], {
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', (error) => {
        settle({ ok: false, detail: error.message });
      });
      child.once('exit', (code, signal) => {
        if (action.mode === 'runToCompletion') {
          // A start command that returns when done; the daemon poll decides success.
          settle({ ok: true });
          return;
        }
        if (code === 0) {
          settle({ ok: true });
          return;
        }
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
        settle({ ok: false, detail: `${action.command} exited with ${detail}` });
      });
      child.once('spawn', () => {
        if (action.mode === 'launchApp') {
          // A GUI app keeps running, so a clean spawn is a strong success signal;
          // give it a brief grace window to surface an immediate failure instead.
          graceTimer = setTimeout(() => settle({ ok: true }), RUNTIME_LAUNCH_FAILURE_GRACE_MS);
        }
        // runToCompletion: wait for the real exit (a machine boot can take tens of seconds).
      });
      child.unref();
    } catch (error) {
      settle({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function waitForRuntimeAfterLaunch(candidate: RuntimeCandidate): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `PrairieLearn Preview: Waiting for ${candidate.profile.displayName} to start…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (token.isCancellationRequested) return false;
        const availability = await probeCandidate(candidate);
        if (availability.kind === 'available') {
          buildRuntime(candidate);
          return true;
        }
        await delay(RUNTIME_START_POLL_INTERVAL_MS);
      }
      void vscode.window.showWarningMessage(
        `PrairieLearn Preview: ${candidate.profile.displayName} is taking longer than expected to start. Run the preview again once it is ready.`,
      );
      return false;
    },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Global-state key recording the pinned image whose cleanup we already offered. */
const LAST_CLEANUP_IMAGE_KEY = 'plPreview.lastCleanupPromptedImage';

/**
 * "Delete old preview images": remove every preview image superseded by an update
 * (all of the current image's repo except the pinned one). Resolves a runtime first
 * — reusing the guided install/start remediation — so it works even before any
 * preview has been opened this session.
 */
async function deleteOldImages(): Promise<void> {
  if (!(await ensureRuntimeReady())) {
    return;
  }

  let images: RemovablePreviewImage[];
  try {
    images = await getRuntime().listRemovablePreviewImages();
  } catch (error) {
    getOutput().appendLine(`[pl-preview] could not list preview images: ${formatError(error)}`);
    void vscode.window
      .showErrorMessage('PrairieLearn Preview: Could not list preview images.', 'Show logs')
      .then((choice) => {
        if (choice === 'Show logs') getOutput().show(true);
      });
    return;
  }

  if (images.length === 0) {
    void vscode.window.showInformationMessage('PrairieLearn Preview: No old preview images to remove.');
    return;
  }

  await confirmAndRemoveImages(images);
}

/**
 * Confirm the itemized deletion in one modal, then remove each image behind a
 * progress notification — tallying reclaimed space and reporting any image still
 * bound to a running container as skipped rather than force-removing it out from
 * under a live preview. Shared by the command and the update auto-prompt.
 */
async function confirmAndRemoveImages(images: readonly RemovablePreviewImage[]): Promise<void> {
  const total = images.reduce((sum, image) => sum + image.size, 0);
  const list = images.map((image) => `  • ${image.name}  ${formatBytes(image.size)}`).join('\n');
  const choice = await vscode.window.showWarningMessage(
    `Delete ${images.length} old preview image${images.length === 1 ? '' : 's'}?`,
    {
      modal: true,
      detail: `These superseded PrairieLearn images will be removed (reclaims ~${formatBytes(total)}):\n${list}`,
    },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  const skipped: RemovablePreviewImage[] = [];
  let reclaimed = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'PrairieLearn Preview: Removing old preview images…',
    },
    async () => {
      for (const image of images) {
        try {
          await getRuntime().removePreviewImage(image.id);
          reclaimed += image.size;
          getOutput().appendLine(`[pl-preview] removed image ${image.name} (${formatBytes(image.size)})`);
        } catch (error) {
          skipped.push(image);
          getOutput().appendLine(`[pl-preview] could not remove image ${image.name}: ${formatError(error)}`);
        }
      }
    },
  );

  const removed = images.length - skipped.length;
  const summary =
    `PrairieLearn Preview: Removed ${removed} image${removed === 1 ? '' : 's'} (reclaimed ~${formatBytes(reclaimed)}).` +
    (skipped.length > 0 ? ` ${skipped.length} still in use — skipped.` : '');
  void vscode.window.showInformationMessage(summary);
}

/**
 * After an update swaps the pinned image, offer to delete the one it replaced —
 * at most once per version. Strictly best-effort: it never launches Docker just to
 * check (it binds only a runtime that already answers), and it leaves the marker
 * unset when the daemon is unreachable so a later activation retries. Once it has
 * actually looked, the marker advances regardless of the choice, so a dismissal is
 * respected until the next update.
 */
async function maybeOfferImageCleanup(context: vscode.ExtensionContext): Promise<void> {
  try {
    const current = resolvePreviewImage();
    if (context.globalState.get<string>(LAST_CLEANUP_IMAGE_KEY) === current) {
      return;
    }

    // Silent probe: bind a runtime only if one is already reachable — no remediation
    // UI, no launching Docker. Nothing up yet? Retry on a later activation.
    const selection = await resolveRuntimeSelection(readRuntimeConfig(), endpointContext(), probeCandidate);
    if (selection.kind !== 'available') {
      return;
    }
    buildRuntime(selection.candidate);

    const images = await getRuntime().listRemovablePreviewImages();
    await context.globalState.update(LAST_CLEANUP_IMAGE_KEY, current);
    if (images.length === 0) {
      return;
    }

    const total = images.reduce((sum, image) => sum + image.size, 0);
    const choice = await vscode.window.showInformationMessage(
      `PrairieLearn Preview: ${images.length} old preview image${images.length === 1 ? '' : 's'} can be removed (~${formatBytes(total)}).`,
      'Delete',
    );
    if (choice === 'Delete') {
      await confirmAndRemoveImages(images);
    }
  } catch (error) {
    getOutput().appendLine(`[pl-preview] image-cleanup check skipped: ${formatError(error)}`);
  }
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
    // "Delete old preview images": reclaim the disk left by superseded image pins.
    vscode.commands.registerCommand(DELETE_OLD_IMAGES_COMMAND, () => deleteOldImages()),
    // Rebind the runtime when the author changes the runtime/endpoint settings, so
    // the next preview resolves against the new selection (and warm containers on
    // the old runtime are stopped).
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('plPreview.containerRuntime') ||
        event.affectsConfiguration('plPreview.containerHost') ||
        event.affectsConfiguration('plPreview.enableWorkspaces')
      ) {
        void resetRuntime();
      }
    }),
    // Granting trust unlocks workspace-question support, so drop the current
    // runtime and rebuild it (with the socket mounted) on the next preview.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void resetRuntime();
    }),
  );

  watchPreviewability(context);

  // A new extension release pins a new image; offer to reclaim the one it replaced
  // (best-effort, at most once per version, and only if a runtime is already up).
  void maybeOfferImageCleanup(context);
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
  disposePreviewSink();
  controller?.dispose();
  controller = undefined;
  panel?.dispose();
  panel = undefined;
  await runtime?.stopAll();
  runtime = undefined;
  output?.dispose();
  output = undefined;
}

function disposePreviewSink(): void {
  previewSink?.dispose();
  previewSink = undefined;
}
