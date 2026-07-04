<div align="center">
  <img src="https://raw.githubusercontent.com/runjuu/pl-preview-vscode/main/media/icon-original.png" alt="PL Preview icon" width="180">
  <h1>PL Preview for VS Code</h1>
  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=runjuu.pl-preview-vscode"><img alt="VS Code Marketplace" src="https://vsmarketplacebadges.dev/version-short/runjuu.pl-preview-vscode.svg?label=VS%20Code%20Marketplace"></a>
    <a href="https://open-vsx.org/extension/runjuu/pl-preview-vscode"><img alt="Open VSX Version" src="https://img.shields.io/open-vsx/v/runjuu/pl-preview-vscode?label=Open%20VSX"></a>
    <a href="https://github.com/runjuu/pl-preview-vscode/actions/workflows/ci.yml"><img alt="Coverage" src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/runjuu/pl-preview-vscode/badges/coverage.json"></a>
    <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <a href="https://code.visualstudio.com/"><img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC"></a>
  </p>
</div>

Preview PrairieLearn questions beside the files you are editing. PL Preview starts
a local container-backed preview server for your course — using Docker or Podman —
and renders the active question in a VS Code webview.

[![PL Preview demo](https://raw.githubusercontent.com/runjuu/pl-preview-vscode/main/media/demo-preview.gif)](https://github.com/runjuu/pl-preview-vscode/raw/main/media/demo.mp4)

## Features

- Open the preview from the editor title bar when a PrairieLearn question file is
  active.
- Follow the active editor as you move between question files.
- Refresh automatically after save, with a manual refresh command when you need
  it.
- Keep the same variant seed across refreshes so edits are easy to compare.
- Reroll the current question with **New variant**.
- Preview **workspace questions** — open the live workspace container in its own
  VS Code tab (in a trusted workspace; see [Workspace questions](#workspace-questions)).
- Show render and container logs from the **PL Preview** Output channel.
- Keep preview servers warm for recently used courses, with a command to stop
  them when you are done.

## Requirements

- VS Code 1.90.0 or newer
- A Docker-Engine-API-compatible container runtime installed and running — Docker
  Desktop or Podman (Colima, Rancher Desktop, and OrbStack work too through their
  Docker-compatible socket)
- A PrairieLearn course folder open in VS Code, with `infoCourse.json` at the
  course root
- PrairieLearn v3/Freeform questions

## Install

Install **PL Preview** from the VS Code Marketplace:

1. Open the Extensions view in VS Code.
2. Search for `runjuu.pl-preview-vscode`.
3. Select **Install**.

PL Preview activates when your workspace contains a PrairieLearn
`infoCourse.json` file.

## Quick Start

1. Open a PrairieLearn course folder in VS Code.
2. Open any file inside a question directory, such as
   `questions/my-question/question.html`.
3. Click the preview button in the editor title bar.
4. Keep editing your question source. Save the file to refresh the preview.

The preview opens beside your editor and follows the active PrairieLearn question
as you switch files.

## Commands

You can also run PL Preview commands from the Command Palette:

| Command | What it does |
| --- | --- |
| **PL Preview: Open PL Preview** | Opens the side-by-side preview for the active question. |
| **PL Preview: Refresh preview** | Re-renders the current preview immediately. |
| **PL Preview: New variant** | Rerolls the current question's variant seed. |
| **PL Preview: Show logs** | Opens the **PL Preview** Output channel. |
| **PL Preview: Stop preview servers** | Stops all running local preview servers. |

## Container runtime

PL Preview runs the preview server in a local container using any
Docker-Engine-API-compatible runtime. By default it auto-detects one — Docker's
socket first, then Podman's — so Docker Desktop, Podman, Colima, Rancher Desktop,
and OrbStack all work with no configuration.

To choose a runtime explicitly, set these in VS Code settings:

| Setting | What it does |
| --- | --- |
| `plPreview.containerRuntime` | `auto` (default), `docker`, `podman`, or `custom`. |
| `plPreview.containerHost` | An explicit endpoint, e.g. `unix:///run/user/1000/podman/podman.sock`, `tcp://127.0.0.1:2375`, or `npipe:////./pipe/podman-machine-default`. Required for `custom`; with `auto` it overrides detection. |
| `plPreview.enableWorkspaces` | `true` (default). Preview workspace questions; see [Workspace questions](#workspace-questions). Set to `false` to keep the preview container fully jailed. |

When multiple runtimes are running and `auto` is selected, Docker is preferred;
set `plPreview.containerRuntime` to `podman` to force Podman.

**Podman on macOS/Windows.** Podman runs inside a `podman machine` VM whose socket
path is not reliably discoverable. Either run `podman-mac-helper install` (so the
default Docker socket points at Podman and `auto` just works), export
`CONTAINER_HOST` before launching VS Code, or set `plPreview.containerHost` to the
machine's socket (from `podman machine inspect`). On Linux, the rootless socket
(`$XDG_RUNTIME_DIR/podman/podman.sock`) is detected automatically.

## Workspace questions

Workspace questions run an interactive per-variant container (a terminal, VS Code
in the browser, JupyterLab, and so on). To preview one, the preview server must be
able to launch that container itself, so PL Preview mounts the container runtime
socket into the preview container and connects both to a shared per-course network.
Everything is proxied through the preview server, so the live workspace opens in a
separate VS Code tab — click **Open workspace** on a workspace question.

Because this lets previewed course code talk to your container runtime (which is
root-equivalent with a rootful daemon), it is enabled only when **both** hold:

- **The workspace is trusted.** PL Preview declares limited support for untrusted
  workspaces, so other question types still preview in an untrusted folder, but
  workspace previews stay off until you trust the workspace. You can also turn the
  feature off entirely with `plPreview.enableWorkspaces: false`.
- **The runtime is socket-based** — Docker Desktop, or Docker/Podman on Linux. A
  Podman machine on macOS/Windows (reached over a TCP/SSH endpoint) has no local
  socket to mount, so workspace previews are unavailable there; plain questions
  still preview.

Prefer **rootless Podman** where you can: if the mounted socket is a rootless
daemon's, a compromise costs your user account rather than host root.

## Limitations

- A container runtime (Docker or Podman) is required. The preview server runs in a
  local container.
- First use can take a few minutes while the runtime downloads the preview image.
- Only PrairieLearn v3/Freeform questions are previewed.
- Unsaved editor changes are not rendered. Save the file to refresh the preview.

## Troubleshooting

**The preview button is missing.**

Make sure the active file is inside a PrairieLearn question directory under
`questions/`, and that the opened workspace contains the course's
`infoCourse.json`.

**No container runtime is installed or running.**

Install Docker Desktop or Podman and start it, then open the preview again. If you
use Podman on macOS or Windows, see **Container runtime** above for pointing PL
Preview at the `podman machine` socket.

**The first preview is slow.**

The first run may download the preview image. Later previews reuse the downloaded
image and warm preview servers.

**The panel says the question type is not previewable.**

PL Preview renders v3/Freeform questions. Check the question's `info.json`.

**The preview failed.**

Run **PL Preview: Show logs** from the Command Palette and check the **PL
Preview** Output channel for the full render or container error.

## Development

```sh
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck
```

Press <kbd>F5</kbd> in VS Code and choose **Run Extension** to launch an
Extension Development Host. Open a PrairieLearn course folder, open a question
file, and click the preview button in the editor title bar.

Use `PL_PREVIEW_IMAGE` to point the extension at a self-built preview image.
