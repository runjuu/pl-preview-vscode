# Changelog

All notable changes to PrairieLearn Preview will be documented in this file.

## Unreleased

- Add common Prairie misspellings and single-character omissions to the extension
  keywords so PrairieLearn searches are more forgiving.

## 1.2.0 - 2026-07-06

- Support workspace question previews on Windows with Docker Desktop by storing
  workspace homes in a daemon-managed named volume, mounting the daemon's in-VM
  socket, and falling back to no-workspace previews when the Docker Engine is too
  old for per-workspace volume subpaths.
- Report the specific reason workspace support is disabled, such as an untrusted
  workspace, a non-local runtime endpoint, the `plPreview.enableWorkspaces`
  setting, or an unsupported Docker Engine version.
- Update the pinned preview-server image to `sha-bfbe099`.
- Keep the preview image version and layer-count note aligned on the startup
  pull step while the first-use image download is in progress.

## 1.1.0 - 2026-07-06

- Fix workspace questions failing with "Docker is not reachable: connect EACCES
  /var/run/docker.sock" on macOS/Windows. Docker Desktop re-presents the mounted
  runtime socket as `root:root` inside the container, so the hardened non-root
  preview container could not open it; it is now granted supplementary group 0
  on those platforms.
- Support Podman and other Docker-Engine-API-compatible runtimes (Colima, Rancher
  Desktop, OrbStack) in addition to Docker. The runtime is auto-detected — Docker's
  socket first, then Podman's — and can be pinned with the new
  `plPreview.containerRuntime` setting (`auto` / `docker` / `podman` / `custom`) or
  pointed at an explicit endpoint with `plPreview.containerHost` (e.g. a Podman
  socket or a `tcp://` host).
- Generalize the first-run guidance to the selected runtime: the "installed but not
  running" notification offers "Start Docker Desktop" or "Start Podman machine"
  (and `systemctl --user start podman.socket` on Linux), launches it, waits for the
  daemon behind a cancellable progress notification, and opens the preview once it
  is ready.

## 1.0.0 - 2026-07-04

- Initial Marketplace release.
- Preview PrairieLearn v3/Freeform questions in a VS Code webview.
- Start and reuse Docker-backed local preview servers per course.
- Refresh previews on save while keeping a stable variant seed.
- Reroll the current question with the New variant command.
- Surface Docker startup, image download, render, and container logs through VS Code.
