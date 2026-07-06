/**
 * Pure helpers and identifiers for the PrairieLearn Preview webview panel.
 *
 * Kept free of any `vscode` import so it can be unit-tested with `tsx --test`.
 * Covers the empty, cold-start (with its live startup overview), and
 * rendered-question states around the loopback `<iframe>`, including the Stable
 * Preview Variant toolbar.
 */

import { type PreviewStartupProgress, describeStartupProgress } from './startupProgress';

/** Command id contributed by the extension manifest to open the preview. */
export const OPEN_PREVIEW_COMMAND = 'plPreview.openPreview';

/** Command id that forces an immediate re-render of the current preview. */
export const REFRESH_PREVIEW_COMMAND = 'plPreview.refreshPreview';

/** Command id that rerolls the current question's Stable Preview Variant seed. */
export const NEW_VARIANT_COMMAND = 'plPreview.newVariant';

/** Command id that reveals the container-log Output channel (the "Show logs" action). */
export const SHOW_LOGS_COMMAND = 'plPreview.showLogs';

/** Command id that stops every running preview container to reclaim resources. */
export const STOP_SERVERS_COMMAND = 'plPreview.stopServers';

/** Stable view type used when creating the webview panel. */
export const PREVIEW_VIEW_TYPE = 'plPreview.panel';

/** Stable view type used when creating a workspace webview tab. */
export const WORKSPACE_VIEW_TYPE = 'plPreview.workspace';

/** Default tab title, shown before a question resolves and in the empty state. */
export const PREVIEW_PANEL_TITLE = 'PrairieLearn Preview';

/** Default tab title for workspace pages opened from a preview. */
export const WORKSPACE_PANEL_TITLE = 'PrairieLearn Workspace';

/**
 * The panel tab title for a previewed question: its `info.json` title (the caller
 * falls back to the qid when it is missing) suffixed with ` (Preview)`, or the
 * plain {@link PREVIEW_PANEL_TITLE} when nothing is being previewed. This is what
 * lets the tab name the question instead of a generic preview title.
 */
export function previewPanelTitle(questionName: string | undefined): string {
  const trimmed = questionName?.trim();
  return trimmed ? `${trimmed} (Preview)` : PREVIEW_PANEL_TITLE;
}

/**
 * The panel tab title for a workspace opened from a previewed question: the
 * question's name (its `info.json` title, or the qid fallback) suffixed with
 * ` (Workspace)`, mirroring {@link previewPanelTitle}. Falls back to
 * `Workspace <id>` when the opening question is unknown, or the plain
 * {@link WORKSPACE_PANEL_TITLE} when even the id is missing.
 */
export function workspacePanelTitle(
  questionName: string | undefined,
  id: string | undefined,
): string {
  const trimmed = questionName?.trim();
  if (trimmed) return `${trimmed} (Workspace)`;
  return id ? `Workspace ${id}` : WORKSPACE_PANEL_TITLE;
}

/** Escape a string for safe interpolation into HTML text or an attribute value. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A fresh random hex nonce. The rendered-question document ties its CSP
 * `script-src` to this value and stamps it on its one inline `<script>`, so only
 * that script (the "New variant" button wiring) may run — nothing an injected
 * `<script>` could smuggle in.
 */
function scriptNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Shared centred layout for the extension's own (non-iframe) message states. */
const MESSAGE_STATE_STYLE = `
      body {
        font-family: var(--vscode-font-family, sans-serif);
        color: var(--vscode-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        text-align: center;
      }
      main {
        max-width: 32rem;
        padding: 1.5rem;
      }
      h1 {
        font-size: 1.1rem;
        font-weight: 600;
      }
      p {
        opacity: 0.8;
        line-height: 1.5;
      }`;

/**
 * A locked-down message document (empty / cold-start states). It loads no
 * scripts or remote resources, so a `default-src 'none'` CSP allows only inline
 * styling. `previewPanelHtml` is the one document that relaxes this to frame the
 * container origin.
 */
function messageStateHtml(heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(PREVIEW_PANEL_TITLE)}</title>
    <style>${MESSAGE_STATE_STYLE}
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`;
}

/** HTML for the empty preview panel shown when there is nothing to render. */
export function emptyPanelHtml(): string {
  return messageStateHtml(
    PREVIEW_PANEL_TITLE,
    'Nothing to preview yet. Open a PrairieLearn question and the rendered preview will appear here.',
  );
}

/**
 * HTML for the cold-start overview shown while the Local Preview Container warms
 * up. Unlike the other message states this document runs one nonce'd inline
 * script: the shell mounts it once, then posts `{ type: 'progress', … }` messages
 * (a {@link describeStartupProgress} view) that update the phase stepper and the
 * progress bar in place — rebuilding the whole document on every download tick
 * would flash and restart the CSS animation. The initial paint reflects
 * `progress` so a first frame already shows the current phase.
 *
 * The three phases (download image → start container → wait for server) render as
 * a stepper: the active row is highlighted, earlier rows read done, later rows
 * pending, and the active row shows a spinning loading indicator in place of its
 * marker. CSP keeps `default-src 'none'` and only relaxes it for the one nonce'd script.
 */
export function startingPanelHtml(progress?: PreviewStartupProgress): string {
  const view = describeStartupProgress(progress);
  const nonce = scriptNonce();
  const stepsHtml = view.steps
    .map((step, index) => {
      // The raw Docker status line lives under the pull step (index 0), the only
      // phase it describes; it stays in the DOM (updated in place) but hides when empty.
      const detail =
        index === 0 ? `<span class="detail" id="detail">${escapeHtml(view.detail ?? '')}</span>` : '';
      return (
        `<li id="step-${index}" data-status="${step.status}">` +
        `<span class="label">${escapeHtml(step.label)}</span>` +
        `<span class="note">${escapeHtml(step.note ?? '')}</span>${detail}</li>`
      );
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(PREVIEW_PANEL_TITLE)}</title>
    <style>${MESSAGE_STATE_STYLE}
      .steps {
        list-style: none;
        padding: 0;
        margin: 1.25rem auto 0;
        max-width: 20rem;
        text-align: left;
      }
      .steps li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.3rem 0.6rem;
        padding: 0.2rem 0;
        opacity: 0.55;
      }
      .steps li[data-status="done"] {
        opacity: 0.8;
      }
      .steps li[data-status="active"] {
        opacity: 1;
      }
      /* Every marker is a ring the size of the active spinner. Pending rings sit
         static and faint; the active ring adds an accent arc and spins; done
         collapses to a check. */
      .steps li::before {
        content: "";
        width: 0.85rem;
        height: 0.85rem;
        margin: 0 0.075rem;
        flex: none;
        box-sizing: border-box;
        align-self: center;
        border-radius: 50%;
        border: 2px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.25));
      }
      .steps li[data-status="active"]::before {
        border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        animation: pl-spin 0.7s linear infinite;
      }
      .steps li[data-status="done"]::before {
        content: "✓";
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        font-size: 0.85rem;
        color: var(--vscode-charts-green, var(--vscode-foreground));
      }
      .steps .note {
        margin-left: auto;
        padding-left: 1rem;
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
      @keyframes pl-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .steps li[data-status="active"]::before {
          animation: none;
          border-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
        }
      }
      /* The latest raw Docker status line, tucked under the "Pulling preview image" row and
         indented to line up with the step's label (past the icon). Hidden when empty. */
      .steps .detail {
        flex-basis: 100%;
        box-sizing: border-box;
        padding-left: 1.6rem;
        font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
        font-size: 0.72rem;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        opacity: 0.7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .steps .detail:empty {
        display: none;
      }
      .footnote {
        margin-top: 1rem;
        font-size: 0.85rem;
        opacity: 0.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1 id="heading">${escapeHtml(view.heading)}</h1>
      <ol class="steps">${stepsHtml}</ol>
      <p class="footnote">Only the first launch downloads the preview image. Once ready, edit and preview your question in real time, without leaving your editor.</p>
    </main>
    <script nonce="${nonce}">
      const heading = document.getElementById('heading');
      const detail = document.getElementById('detail');
      const rows = [
        document.getElementById('step-0'),
        document.getElementById('step-1'),
        document.getElementById('step-2'),
      ];
      // Update the stepper in place from a posted describeStartupProgress view, so
      // an in-flight download never rebuilds the document.
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.type !== 'progress') return;
        if (typeof message.heading === 'string') heading.textContent = message.heading;
        if (detail) detail.textContent = typeof message.detail === 'string' ? message.detail : '';
        const steps = Array.isArray(message.steps) ? message.steps : [];
        rows.forEach((row, i) => {
          const step = steps[i];
          if (!row || !step) return;
          if (typeof step.status === 'string') row.dataset.status = step.status;
          const label = row.querySelector('.label');
          const note = row.querySelector('.note');
          if (label && typeof step.label === 'string') label.textContent = step.label;
          if (note) note.textContent = typeof step.note === 'string' ? step.note : '';
        });
      });
    </script>
  </body>
</html>`;
}

/**
 * HTML for the "not previewable for this type" state: a friendly explanation that
 * the question's `info.json` `type` is not v3/Freeform, so it cannot be rendered.
 * Locked down like the other message states (no scripts, no remote resources).
 */
export function notPreviewablePanelHtml(type: string): string {
  const named = type.trim().length > 0 ? `“${type}”` : 'this';
  return messageStateHtml(
    'Not previewable for this type',
    `PrairieLearn Preview renders v3 (Freeform) questions. ${named} questions are a known limitation and are not previewed.`,
  );
}

/**
 * HTML for a loud render/launch failure. Shows a short message and directs the
 * author to the "Show logs" action (the {@link SHOW_LOGS_COMMAND} Command Palette
 * command / the error notification button) that reveals the container's Output
 * channel with the full traceback. Locked down like the other message states.
 */
export function errorPanelHtml(message: string): string {
  return messageStateHtml(
    'Preview failed',
    `${message}. Run “PrairieLearn Preview: Show logs” from the Command Palette to view the full logs.`,
  );
}

export interface PreviewPanelInput {
  /** Loopback URL the `<iframe>` renders. */
  src: string;
  /** Current Stable Preview Variant seed, shown in the toolbar. */
  variant: string;
  /** Unguessable token required on host-to-webview update messages. */
  hostMessageToken?: string;
  /** Unguessable token accepted from the proxied question iframe's workspace bridge. */
  workspaceBridgeToken?: string;
  /** Real preview-server origin that workspace URLs must target. */
  workspaceTargetOrigin?: string;
}

/**
 * HTML for the rendered-question state: a thin toolbar showing the current Stable
 * Preview Variant and a "New variant" button, above an `<iframe>` pointed at the
 * container's loopback origin. The question's name lives on the panel *tab* (set
 * by the controller via {@link previewPanelTitle}), so the toolbar no longer
 * repeats a redundant PrairieLearn Preview heading.
 *
 * The CSP relaxes `default-src 'none'` only far enough to frame that one origin
 * (`frame-src <origin>`), so the preview server's absolute-from-root asset URLs
 * (`/preview-render/*`, `/assets/*`) resolve while nothing else may be framed,
 * plus a single nonce'd `script-src` for the toolbar and workspace-link bridge
 * messages. The question iframe points at a same-process loopback proxy, so
 * workspace links rendered by `pl-workspace` can be rewritten to post an
 * `openWorkspace` request to the extension host. The iframe sandbox adds
 * `allow-forms` (question submission POSTs), `allow-popups` plus
 * `allow-popups-to-escape-sandbox` as a browser-native fallback for target-blank
 * links, and `allow-modals`/`allow-downloads` for interactive workspace UIs
 * (terminals, VNC, notebooks), on top of `allow-scripts allow-same-origin`;
 * `referrerpolicy="no-referrer"` stays.
 */
export function previewPanelHtml({
  src,
  variant,
  hostMessageToken = scriptNonce(),
  workspaceBridgeToken = scriptNonce(),
  workspaceTargetOrigin = new URL(src).origin,
}: PreviewPanelInput): string {
  const origin = new URL(src).origin;
  const nonce = scriptNonce();
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(PREVIEW_PANEL_TITLE)}</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        /* Override the host's default webview body padding so the toolbar and the
           iframe render edge-to-edge instead of inset from the panel sides. */
        padding: 0;
      }
      body {
        display: flex;
        flex-direction: column;
        font-family: var(--vscode-font-family, sans-serif);
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.25rem 0.75rem;
        font-size: 0.8rem;
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background, transparent);
        border-bottom: 1px solid var(--vscode-widget-border, transparent);
      }
      /* The seed is plain text; the only affordance is the button. No accent
         fills, so the preview keeps the author's eye rather than the chrome. */
      .toolbar .seed {
        color: var(--vscode-foreground);
      }
      .toolbar .seed-label {
        opacity: 0.55;
      }
      .toolbar .seed code {
        font-family: var(--vscode-editor-font-family, monospace);
        background: none;
      }
      .toolbar .reroll {
        margin-left: auto;
        font: inherit;
        padding: 0.3rem 1rem;
        color: var(--vscode-foreground);
        background: transparent;
        border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.15s ease, transform 0.1s ease;
      }
      .toolbar .reroll:hover {
        background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
      }
      .toolbar .reroll:active {
        transform: scale(0.96);
      }
      .toolbar .reroll:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      /* A white surround carries the inset spacing so it reads as padding on the
         rendered question (itself a white page) rather than a dark frame. The
         column flex fills the remaining height; min-height:0 lets it shrink. */
      .content {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        padding: 0.75rem;
        background: #ffffff;
      }
      iframe {
        border: 0;
        width: 100%;
        min-height: 0;
        flex: 1 1 auto;
        display: block;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <span class="seed"><span class="seed-label">seed:</span> <code>${escapeHtml(variant)}</code></span>
      <button type="button" class="reroll" title="Render a new randomized variant">New variant</button>
    </div>
    <div class="content">
      <iframe
        src="${escapeHtml(src)}"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        referrerpolicy="no-referrer"
        title="${escapeHtml(PREVIEW_PANEL_TITLE)}"
      ></iframe>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const hostMessageToken = ${JSON.stringify(hostMessageToken)};
      const workspaceBridgeToken = ${JSON.stringify(workspaceBridgeToken)};
      const workspaceFrameOrigin = ${JSON.stringify(origin)};
      const workspaceTargetOrigin = ${JSON.stringify(workspaceTargetOrigin)};
      const iframe = document.querySelector('iframe');
      const seedValue = document.querySelector('.seed code');
      document.querySelector('.reroll').addEventListener('click', () => {
        vscode.postMessage({ type: 'newVariant' });
      });
      // A re-render (save-refresh or new variant) swaps the iframe in place rather
      // than the host rebuilding the whole document — reassigning the panel's HTML
      // would tear down and repaint the toolbar too, which reads as a flash.
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'plPreview.openWorkspace') {
          if (event.origin !== workspaceFrameOrigin) return;
          if (message.token !== workspaceBridgeToken) return;
          if (!isWorkspaceUrl(message.url)) return;
          vscode.postMessage({ type: 'openWorkspace', url: message.url });
          return;
        }
        if (message.token !== hostMessageToken) return;
        if (message.type !== 'render') return;
        if (typeof message.variant === 'string') seedValue.textContent = message.variant;
        iframe.src = message.src;
      });
      function isWorkspaceUrl(value) {
        if (typeof value !== 'string') return false;
        try {
          const url = new URL(value);
          return url.origin === workspaceTargetOrigin && /(^|\\/)workspace\\/[^/?#]+\\/?$/.test(url.pathname);
        } catch {
          return false;
        }
      }
    </script>
  </body>
</html>`;
}

export interface WorkspacePanelInput {
  /** Loopback URL for the preview-server workspace page. */
  src: string;
  /** Unguessable token required on host-to-webview status/reload messages. */
  hostMessageToken?: string;
}

/**
 * HTML for a workspace page opened from a rendered question in its own webview tab.
 *
 * A thin control bar carries a live status dot/label and Reboot/Reset buttons above a
 * full-bleed `<iframe>` pointed at the container's loopback origin. The buttons post
 * `reboot`/`reset` to the extension host, which confirms with a native modal, drives the
 * preview server's reboot/reset endpoints, and reloads the page. The webview cannot reach
 * the loopback server itself (its CSP is `default-src 'none'`, blocking `connect-src`),
 * so the host polls `/status` and pushes updates in via token-gated `postMessage`.
 *
 * The CSP relaxes `default-src 'none'` only far enough to frame that one origin
 * (`frame-src <origin>`) plus a single nonce'd `script-src` for the toolbar wiring. The
 * iframe sandbox mirrors the preview panel's (forms, popups, modals, downloads for
 * interactive workspace UIs) and keeps `referrerpolicy="no-referrer"`.
 */
export function workspacePanelHtml({
  src,
  hostMessageToken = scriptNonce(),
}: WorkspacePanelInput): string {
  const origin = new URL(src).origin;
  const nonce = scriptNonce();
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(WORKSPACE_PANEL_TITLE)}</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        /* Override the host's default webview body padding so the toolbar and the
           iframe render edge-to-edge instead of inset from the panel sides. */
        padding: 0;
      }
      body {
        display: flex;
        flex-direction: column;
        font-family: var(--vscode-font-family, sans-serif);
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.25rem 0.75rem;
        font-size: 0.8rem;
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background, transparent);
        border-bottom: 1px solid var(--vscode-widget-border, transparent);
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        color: var(--vscode-foreground);
      }
      /* The dot colour tracks the workspace state; the label carries the server's own
         human-readable message. Chart colours read well on both light and dark themes. */
      .status .dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        background: var(--vscode-descriptionForeground, #888);
      }
      .status[data-state='running'] .dot {
        background: var(--vscode-charts-green, #89d185);
      }
      .status[data-state='launching'] .dot,
      .status[data-state='uninitialized'] .dot {
        background: var(--vscode-charts-yellow, #e2c08d);
      }
      .status[data-state='failed'] .dot {
        background: var(--vscode-charts-red, #f14c4c);
      }
      .actions {
        margin-left: auto;
        display: inline-flex;
        gap: 0.5rem;
      }
      .btn {
        font: inherit;
        padding: 0.3rem 1rem;
        color: var(--vscode-foreground);
        background: transparent;
        border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.3));
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.15s ease, transform 0.1s ease;
      }
      .btn:hover {
        background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
      }
      .btn:active {
        transform: scale(0.96);
      }
      .btn:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      iframe {
        border: 0;
        display: block;
        width: 100%;
        min-height: 0;
        flex: 1 1 auto;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <span class="status" data-state="uninitialized">
        <span class="dot"></span>
        <span class="status-label">Starting…</span>
      </span>
      <span class="actions">
        <button
          type="button"
          class="btn reboot"
          aria-label="Reboot workspace"
          title="Restart the workspace container (files are kept)"
        >Reboot</button>
        <button
          type="button"
          class="btn reset"
          aria-label="Reset workspace"
          title="Discard all changes and restore the original files"
        >Reset</button>
      </span>
    </div>
    <iframe
      src="${escapeHtml(src)}"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      referrerpolicy="no-referrer"
      title="${escapeHtml(WORKSPACE_PANEL_TITLE)}"
    ></iframe>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const hostMessageToken = ${JSON.stringify(hostMessageToken)};
      const iframe = document.querySelector('iframe');
      const status = document.querySelector('.status');
      const statusLabel = document.querySelector('.status-label');
      document.querySelector('.reboot').addEventListener('click', () => {
        vscode.postMessage({ type: 'reboot' });
      });
      document.querySelector('.reset').addEventListener('click', () => {
        vscode.postMessage({ type: 'reset' });
      });
      // The webview can't reach the loopback server (CSP default-src 'none'), so the host
      // polls /status and pushes state in, and after a reboot/reset swaps the iframe in
      // place rather than rebuilding the document — reassigning the panel HTML would
      // repaint the toolbar too, which reads as a flash.
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.token !== hostMessageToken) return;
        if (message.type === 'status') {
          if (typeof message.state === 'string') status.dataset.state = message.state;
          if (typeof message.message === 'string') statusLabel.textContent = message.message;
          return;
        }
        if (message.type === 'reload' && typeof message.src === 'string') {
          iframe.src = message.src;
        }
      });
    </script>
  </body>
</html>`;
}
