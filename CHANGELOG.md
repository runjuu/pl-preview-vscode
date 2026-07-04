# Changelog

All notable changes to PL Preview will be documented in this file.

## Unreleased

- Add a "Start Docker Desktop" action to the "Docker is installed but not running"
  notification: it launches Docker Desktop (macOS/Windows), waits for the daemon
  behind a cancellable progress notification, and opens the preview automatically
  once Docker is ready. Linux keeps the manual "start Docker" guidance.

## 1.0.0 - 2026-07-04

- Initial Marketplace release.
- Preview PrairieLearn v3/Freeform questions in a VS Code webview.
- Start and reuse Docker-backed local preview servers per course.
- Refresh previews on save while keeping a stable variant seed.
- Reroll the current question with the New variant command.
- Surface Docker startup, image download, render, and container logs through VS Code.
