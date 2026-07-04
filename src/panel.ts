/**
 * Pure helpers and identifiers for the PL Preview webview panel.
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

/** Default tab title, shown before a question resolves and in the empty state. */
export const PREVIEW_PANEL_TITLE = 'PL Preview';

/**
 * The panel tab title for a previewed question: its `info.json` title (the caller
 * falls back to the qid when it is missing) suffixed with ` (Preview)`, or the
 * plain {@link PREVIEW_PANEL_TITLE} when nothing is being previewed. This is what
 * lets the tab name the question instead of a generic "PL Preview".
 */
export function previewPanelTitle(questionName: string | undefined): string {
  const trimmed = questionName?.trim();
  return trimmed ? `${trimmed} (Preview)` : PREVIEW_PANEL_TITLE;
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
 * pending. The bar is determinate (a percentage width) during the image download
 * and an indeterminate slide otherwise. CSP keeps `default-src 'none'` and only
 * relaxes it for the one nonce'd script.
 */
export function startingPanelHtml(progress?: PreviewStartupProgress): string {
  const view = describeStartupProgress(progress);
  const nonce = scriptNonce();
  const stepsHtml = view.steps
    .map(
      (step, index) =>
        `<li id="step-${index}" data-status="${step.status}">` +
        `<span class="label">${escapeHtml(step.label)}</span>` +
        `<span class="note">${escapeHtml(step.note ?? '')}</span></li>`,
    )
    .join('');
  const mode = view.percent != null ? 'determinate' : 'indeterminate';
  const pct = view.percent ?? 0;
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
        align-items: baseline;
        gap: 0.6rem;
        padding: 0.2rem 0;
        opacity: 0.55;
      }
      .steps li[data-status="done"] {
        opacity: 0.8;
      }
      .steps li[data-status="active"] {
        opacity: 1;
      }
      .steps li::before {
        content: "○";
        width: 1rem;
        flex: none;
        text-align: center;
      }
      .steps li[data-status="done"]::before {
        content: "✓";
        color: var(--vscode-charts-green, var(--vscode-foreground));
      }
      .steps li[data-status="active"]::before {
        content: "●";
        color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      }
      .steps .note {
        margin-left: auto;
        padding-left: 1rem;
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
      .progress {
        height: 4px;
        width: 100%;
        max-width: 20rem;
        margin: 1.25rem auto 0;
        border-radius: 2px;
        overflow: hidden;
        background: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      }
      .progress .bar {
        height: 100%;
        border-radius: 2px;
        background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      }
      .progress[data-mode="determinate"] .bar {
        width: var(--pct, 0%);
        transition: width 0.2s ease;
      }
      .progress[data-mode="indeterminate"] .bar {
        width: 40%;
        animation: pl-slide 1.2s ease-in-out infinite;
      }
      @keyframes pl-slide {
        0% {
          transform: translateX(-110%);
        }
        100% {
          transform: translateX(275%);
        }
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
      <div class="progress" id="progress" data-mode="${mode}" style="--pct: ${pct}%">
        <div class="bar"></div>
      </div>
      <p class="footnote">First use downloads the preview image; later starts skip this.</p>
    </main>
    <script nonce="${nonce}">
      const heading = document.getElementById('heading');
      const progress = document.getElementById('progress');
      const rows = [
        document.getElementById('step-0'),
        document.getElementById('step-1'),
        document.getElementById('step-2'),
      ];
      // Update the stepper and bar in place from a posted describeStartupProgress
      // view, so an in-flight download never rebuilds the document.
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.type !== 'progress') return;
        if (typeof message.heading === 'string') heading.textContent = message.heading;
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
        if (typeof message.percent === 'number') {
          progress.dataset.mode = 'determinate';
          progress.style.setProperty('--pct', message.percent + '%');
        } else {
          progress.dataset.mode = 'indeterminate';
        }
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
    `PL Preview renders v3 (Freeform) questions. ${named} questions are a known limitation and are not previewed.`,
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
    `${message} — run “PL Preview: Show logs” from the Command Palette to view the full logs.`,
  );
}

export interface PreviewPanelInput {
  /** Loopback URL the `<iframe>` renders. */
  src: string;
  /** Current Stable Preview Variant seed, shown in the toolbar. */
  variant: string;
}

/**
 * HTML for the rendered-question state: a thin toolbar showing the current Stable
 * Preview Variant and a "New variant" button, above an `<iframe>` pointed at the
 * container's loopback origin. The question's name lives on the panel *tab* (set
 * by the controller via {@link previewPanelTitle}), so the toolbar no longer
 * repeats a redundant "PL Preview" heading.
 *
 * The CSP relaxes `default-src 'none'` only far enough to frame that one origin
 * (`frame-src <origin>`), so the preview server's absolute-from-root asset URLs
 * (`/preview-render/*`, `/assets/*`) resolve while nothing else may be framed,
 * plus a single nonce'd `script-src` for the button's one inline script — which
 * only posts a `newVariant` message back to the extension host (the reroll runs
 * there, same as the Command Palette command). `frame-src <origin>` also covers
 * the workspace page (same origin) that the iframe navigates to for a workspace
 * question, and its nested container iframe. The iframe sandbox adds `allow-forms`
 * (the workspace page's reboot/reset POST forms) and `allow-popups`/`allow-modals`/
 * `allow-downloads` for interactive workspace UIs (terminals, VNC, notebooks), on
 * top of `allow-scripts allow-same-origin`; `referrerpolicy="no-referrer"` stays.
 */
export function previewPanelHtml({ src, variant }: PreviewPanelInput): string {
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
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        referrerpolicy="no-referrer"
        title="${escapeHtml(PREVIEW_PANEL_TITLE)}"
      ></iframe>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
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
        if (!message || message.type !== 'render') return;
        if (typeof message.variant === 'string') seedValue.textContent = message.variant;
        iframe.src = message.src;
      });
    </script>
  </body>
</html>`;
}
