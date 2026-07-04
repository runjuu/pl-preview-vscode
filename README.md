<div align="center">
  <img src="https://raw.githubusercontent.com/runjuu/pl-preview-vscode/main/media/icon-original.png" alt="PL Preview icon" width="180">
  <h1>PL Preview for VS Code</h1>
  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=runjuu.pl-preview-vscode">
      <img alt="VS Code Marketplace" src="https://vsmarketplacebadges.dev/version-short/runjuu.pl-preview-vscode.svg?label=VS%20Code%20Marketplace">
    </a>
    <a href="https://marketplace.visualstudio.com/items?itemName=runjuu.pl-preview-vscode">
      <img alt="Installs" src="https://vsmarketplacebadges.dev/installs-short/runjuu.pl-preview-vscode.svg?label=Installs">
    </a>
    <a href="./LICENSE">
      <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
    </a>
    <a href="https://code.visualstudio.com/">
      <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC">
    </a>
  </p>
</div>

Preview PrairieLearn questions beside the files you are editing. PL Preview starts
a local Docker-backed preview server for your course and renders the active
question in a VS Code webview.

[![PL Preview demo](https://raw.githubusercontent.com/runjuu/pl-preview-vscode/main/media/demo-preview.gif)](https://github.com/runjuu/pl-preview-vscode/raw/main/media/demo.mp4)

## Features

- Open the preview from the editor title bar when a PrairieLearn question file is
  active.
- Follow the active editor as you move between question files.
- Refresh automatically after save, with a manual refresh command when you need
  it.
- Keep the same variant seed across refreshes so edits are easy to compare.
- Reroll the current question with **New variant**.
- Show render and container logs from the **PL Preview** Output channel.
- Keep preview servers warm for recently used courses, with a command to stop
  them when you are done.

## Requirements

- VS Code 1.90.0 or newer
- Docker Desktop installed and running
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

## Limitations

- Docker is required. The preview server runs in a local container.
- First use can take a few minutes while Docker downloads the preview image.
- Only PrairieLearn v3/Freeform questions are previewed.
- Unsaved editor changes are not rendered. Save the file to refresh the preview.

## Troubleshooting

**The preview button is missing.**

Make sure the active file is inside a PrairieLearn question directory under
`questions/`, and that the opened workspace contains the course's
`infoCourse.json`.

**Docker is not installed or not running.**

Install Docker Desktop, start it, and then open the preview again.

**The first preview is slow.**

The first run may download a Docker image. Later previews reuse the downloaded
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
