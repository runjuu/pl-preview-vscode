# Changelog

All notable changes to PL Preview will be documented in this file.

## Unreleased

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
