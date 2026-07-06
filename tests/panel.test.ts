import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  NEW_VARIANT_COMMAND,
  OPEN_PREVIEW_COMMAND,
  PREVIEW_PANEL_TITLE,
  PREVIEW_VIEW_TYPE,
  REFRESH_PREVIEW_COMMAND,
  SHOW_LOGS_COMMAND,
  WORKSPACE_PANEL_TITLE,
  WORKSPACE_VIEW_TYPE,
  emptyPanelHtml,
  errorPanelHtml,
  notPreviewablePanelHtml,
  previewPanelHtml,
  previewPanelTitle,
  startingPanelHtml,
  workspacePanelHtml,
  workspacePanelTitle,
} from '../src/panel';

const packageRoot = path.dirname(__dirname);

function readManifest(): { contributes: { commands: Array<{ command: string; title: string }> } } {
  return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
}

describe('PL Preview panel', () => {
  it('renders a complete standalone HTML document', () => {
    const html = emptyPanelHtml();

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<html/i);
    assert.match(html, /<\/html>/i);
  });

  it('shows the panel title in the empty state', () => {
    assert.ok(emptyPanelHtml().includes(PREVIEW_PANEL_TITLE));
  });

  it('locks the empty panel down with a default-src none content security policy', () => {
    const html = emptyPanelHtml();

    assert.match(html, /http-equiv="Content-Security-Policy"/i);
    assert.match(html, /default-src 'none'/i);
  });

  it('contributes the open-preview command declared by the constant', () => {
    const commands = readManifest().contributes.commands;
    const openCommand = commands.find((command) => command.command === OPEN_PREVIEW_COMMAND);

    assert.ok(openCommand, `manifest must contribute ${OPEN_PREVIEW_COMMAND}`);
    assert.equal(openCommand.title, 'Open PL Preview');
  });

  it('contributes the refresh-preview command declared by the constant', () => {
    const commands = readManifest().contributes.commands;
    const refreshCommand = commands.find((command) => command.command === REFRESH_PREVIEW_COMMAND);

    assert.ok(refreshCommand, `manifest must contribute ${REFRESH_PREVIEW_COMMAND}`);
    assert.equal(refreshCommand.title, 'Refresh preview');
  });

  it('contributes the new-variant command declared by the constant', () => {
    const commands = readManifest().contributes.commands;
    const newVariantCommand = commands.find((command) => command.command === NEW_VARIANT_COMMAND);

    assert.ok(newVariantCommand, `manifest must contribute ${NEW_VARIANT_COMMAND}`);
    assert.equal(newVariantCommand.title, 'New variant');
  });

  it('contributes the show-logs command declared by the constant', () => {
    const commands = readManifest().contributes.commands;
    const showLogsCommand = commands.find((command) => command.command === SHOW_LOGS_COMMAND);

    assert.ok(showLogsCommand, `manifest must contribute ${SHOW_LOGS_COMMAND}`);
    assert.equal(showLogsCommand.title, 'Show logs');
  });

  it('keeps the command id and view type in the plPreview namespace', () => {
    assert.match(OPEN_PREVIEW_COMMAND, /^plPreview\./);
    assert.match(PREVIEW_VIEW_TYPE, /^plPreview\./);
    assert.match(WORKSPACE_VIEW_TYPE, /^plPreview\./);
  });
});

describe('notPreviewablePanelHtml', () => {
  it('names the unsupported question type in a friendly, locked-down state', () => {
    const html = notPreviewablePanelHtml('Calculation');

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /not previewable/i);
    assert.match(html, /Calculation/);
    assert.match(html, /default-src 'none'/i);
  });

  it('escapes the type so a crafted info.json cannot inject markup', () => {
    const html = notPreviewablePanelHtml('"><script>evil()</script>');

    assert.doesNotMatch(html, /<script>evil/);
  });
});

describe('errorPanelHtml', () => {
  it('surfaces the failure message and points the author at the logs, locked down', () => {
    const html = errorPanelHtml('Cannot connect to the Docker daemon');

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /Cannot connect to the Docker daemon/);
    assert.match(html, /logs/i);
    assert.match(html, /default-src 'none'/i);
  });

  it('escapes the failure message so a traceback cannot inject markup', () => {
    const html = errorPanelHtml('boom "><script>evil()</script>');

    assert.doesNotMatch(html, /<script>evil/);
  });
});

describe('startingPanelHtml', () => {
  it('renders a locked-down cold-start state', () => {
    const html = startingPanelHtml();

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /Starting preview/i);
    assert.match(html, /default-src 'none'/i);
  });

  it('renders the three-phase stepper with the image download active during a pull', () => {
    const html = startingPanelHtml({
      phase: 'pullingImage',
      percent: 42,
      layersDone: 2,
      layersTotal: 5,
      detail: 'Pull complete 6332824b21e0',
    });

    assert.match(html, /Downloading image/);
    assert.match(html, /Starting container/);
    assert.match(html, /Launching preview server/);
    // The download step is active with its layer-count note and a spinning marker.
    assert.match(html, /id="step-0" data-status="active"/);
    assert.match(html, /2\/5 layers/);
    assert.match(html, /@keyframes pl-spin/);
    // The latest raw Docker status line is surfaced under the stepper.
    assert.match(html, /id="detail"[^>]*>Pull complete 6332824b21e0</);
  });

  it('has no progress bar and shows a loading spinner on the active step instead', () => {
    const starting = startingPanelHtml({ phase: 'startingContainer' });

    assert.doesNotMatch(starting, /class="progress"/);
    assert.doesNotMatch(starting, /data-mode=/);
    assert.match(starting, /id="step-1" data-status="active"/);
    assert.match(starting, /@keyframes pl-spin/);
  });

  it('marks earlier phases done once the readiness wait is active', () => {
    const html = startingPanelHtml({ phase: 'waitingForServer', elapsedMs: 3000, timeoutMs: 60000 });

    assert.match(html, /id="step-0" data-status="done"/);
    assert.match(html, /id="step-1" data-status="done"/);
    assert.match(html, /id="step-2" data-status="active"/);
    assert.match(html, />3s</);
  });

  it('updates the stepper in place through a single nonce-guarded script', () => {
    const html = startingPanelHtml();

    // Script execution is scoped to a per-render nonce that stamps the one script…
    const nonceMatch = html.match(/script-src 'nonce-([a-f0-9]+)';/i);
    assert.ok(nonceMatch, 'CSP must scope script-src to a nonce');
    assert.match(html, new RegExp(`<script nonce="${nonceMatch![1]}">`));
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/i);
    // …and it patches the doc from host messages rather than remounting (a flash).
    assert.match(html, /addEventListener\('message'/);
    assert.match(html, /message\.type !== 'progress'/);
  });
});

describe('previewPanelHtml', () => {
  const src = 'http://127.0.0.1:49812/questions/arithmetic?variant=1';

  it('frames the rendered question with the workspace-capable iframe posture', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<iframe/i);
    assert.match(html, new RegExp(`src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    // Scripts + same-origin for the question render, plus forms/popups/modals for
    // the workspace page's reboot/reset controls and interactive workspace UIs.
    assert.match(html, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups/i);
    assert.match(html, /allow-popups-to-escape-sandbox/i);
    assert.match(html, /referrerpolicy="no-referrer"/i);
  });

  it('permits framing only the container loopback origin', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    // The CSP must allow the loopback iframe origin so assets served from
    // /preview-render and /assets load, but not open framing to the world.
    assert.match(html, /frame-src http:\/\/127\.0\.0\.1:49812/i);
    assert.doesNotMatch(html, /frame-src[^;]*\*/i);
  });

  it('shows the current variant seed as plain "seed: <value>" text so it does not read as an ordinal', () => {
    const html = previewPanelHtml({ src, variant: 'abc123' });

    assert.match(html, /class="seed-label">seed:</);
    assert.match(html, /<code>abc123<\/code>/);
  });

  it('animates the New variant button on hover and click', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    // A background transition on hover, and a small scale-down on press.
    assert.match(html, /transition:[^;]*background-color/i);
    assert.match(html, /\.reroll:active[^}]*transform:\s*scale\(/i);
  });

  it('renders edge-to-edge by zeroing the host default webview body padding', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    assert.match(html, /body\s*\{[^}]*padding:\s*0/i);
  });

  it('insets the rendered question with a white surround so the spacing reads as page padding', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    assert.match(html, /\.content\s*\{[^}]*padding:\s*0\.75rem/i);
    assert.match(html, /\.content\s*\{[^}]*background:\s*#f{3,6}/i);
  });

  it('updates the iframe in place on a render message, so a re-render does not reload the panel', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    // The document listens for host messages and swaps the iframe src / seed
    // rather than relying on the host to replace the whole document (a flash).
    assert.match(html, /addEventListener\('message'/);
    assert.match(html, /message\.type !== 'render'/);
    assert.match(html, /iframe\.src = message\.src/);
  });

  it('drops the redundant inner "PL Preview" heading now the tab names the question', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    // The old toolbar heading span is gone; the question name lives on the tab.
    assert.doesNotMatch(html, /class="title"/);
  });

  it('offers a New variant button in the toolbar', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    assert.match(html, /<button[^>]*class="reroll"/i);
    assert.match(html, />New variant</);
  });

  it('drives the New variant button through a single nonce-guarded script', () => {
    const html = previewPanelHtml({ src, variant: '1' });

    // The CSP grants script execution only to a per-render nonce...
    const nonceMatch = html.match(/script-src 'nonce-([a-f0-9]+)';/i);
    assert.ok(nonceMatch, 'CSP must scope script-src to a nonce');
    // ...and that exact nonce is what stamps our one inline script.
    assert.match(html, new RegExp(`<script nonce="${nonceMatch![1]}">`));
    // The script only messages the host; it never uses eval/unsafe-inline scripts.
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/i);
    assert.match(html, /postMessage\(\{ type: 'newVariant' \}\)/);
  });

  it('accepts workspace-open messages from the proxied question iframe', () => {
    const html = previewPanelHtml({
      src: 'http://127.0.0.1:49999/questions/arithmetic?variant=1',
      variant: '1',
      workspaceBridgeToken: 'workspace-token',
      workspaceTargetOrigin: 'http://127.0.0.1:49812',
    });

    assert.match(html, /message\.type === 'plPreview\.openWorkspace'/);
    assert.match(html, /event\.origin !== workspaceFrameOrigin/);
    assert.match(html, /message\.token !== workspaceBridgeToken/);
    assert.match(html, /postMessage\(\{ type: 'openWorkspace', url: message\.url \}\)/);
    assert.match(html, /url\.origin === workspaceTargetOrigin/);
  });

  it('escapes the iframe src so it cannot break out of the attribute', () => {
    const html = previewPanelHtml({
      src: 'http://127.0.0.1:1/questions/a"><script>x?variant=1',
      variant: '1',
    });

    assert.doesNotMatch(html, /<script>x/);
  });

  it('escapes the variant so it cannot break out of the toolbar', () => {
    const html = previewPanelHtml({ src, variant: '"><script>evil()</script>' });

    assert.doesNotMatch(html, /<script>evil/);
  });
});

describe('workspacePanelHtml', () => {
  const src = 'http://127.0.0.1:49812/workspace/1';

  it('frames the workspace page in a complete standalone HTML document', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<iframe/i);
    assert.match(html, new RegExp(`src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(html, new RegExp(`<title>${WORKSPACE_PANEL_TITLE}</title>`));
  });

  it('permits framing only the workspace loopback origin', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /frame-src http:\/\/127\.0\.0\.1:49812/i);
    assert.doesNotMatch(html, /frame-src[^;]*\*/i);
  });

  it('allows the workspace page controls and nested interactive UI to run', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups/i);
    assert.match(html, /allow-popups-to-escape-sandbox/i);
    assert.match(html, /referrerpolicy="no-referrer"/i);
  });

  it('grants only its own nonce-tagged control-bar script', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /script-src 'nonce-/);
    assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/i);
  });

  it('renders the status label and the Reboot/Reset controls', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /class="status"/);
    assert.match(html, /aria-label="Reboot workspace"/);
    assert.match(html, /aria-label="Reset workspace"/);
  });

  it('wires the control bar to the host and gates host messages on the token', () => {
    const html = workspacePanelHtml({ src });

    assert.match(html, /acquireVsCodeApi\(\)/);
    assert.match(html, /postMessage\(\{ type: 'reboot' \}\)/);
    assert.match(html, /postMessage\(\{ type: 'reset' \}\)/);
    assert.match(html, /message\.token !== hostMessageToken/);
    assert.match(html, /message\.type === 'status'/);
    assert.match(html, /message\.type === 'reload'/);
  });

  it('embeds the host message token so the webview can authenticate updates', () => {
    const html = workspacePanelHtml({ src, hostMessageToken: 'ws-token' });

    assert.match(html, /"ws-token"/);
  });
});

describe('previewPanelTitle', () => {
  it("suffixes the question's name with (Preview) for the tab", () => {
    assert.equal(previewPanelTitle('Random arithmetic'), 'Random arithmetic (Preview)');
  });

  it('trims surrounding whitespace before suffixing', () => {
    assert.equal(previewPanelTitle('  Spaced  '), 'Spaced (Preview)');
  });

  it('falls back to the default title for a missing or blank name', () => {
    assert.equal(previewPanelTitle(undefined), PREVIEW_PANEL_TITLE);
    assert.equal(previewPanelTitle('   '), PREVIEW_PANEL_TITLE);
  });
});

describe('workspacePanelTitle', () => {
  it("names the tab after the question, suffixed with (Workspace)", () => {
    assert.equal(workspacePanelTitle('Random arithmetic', '1'), 'Random arithmetic (Workspace)');
  });

  it('trims surrounding whitespace before suffixing', () => {
    assert.equal(workspacePanelTitle('  Spaced  ', '1'), 'Spaced (Workspace)');
  });

  it('falls back to the workspace id when the opening question is unknown', () => {
    assert.equal(workspacePanelTitle(undefined, '7'), 'Workspace 7');
    assert.equal(workspacePanelTitle('   ', '7'), 'Workspace 7');
  });

  it('falls back to the default title when neither name nor id is available', () => {
    assert.equal(workspacePanelTitle(undefined, undefined), WORKSPACE_PANEL_TITLE);
  });
});
