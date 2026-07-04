import fs from 'node:fs';
import path from 'node:path';

import type { ContainerRuntimeProfile } from './runtimeProfiles';

/**
 * Pure classification of container-runtime availability and the actionable
 * remediation to show a first-run author. Kept free of dockerode/VSCode I/O so
 * the load-bearing decisions — "is the runtime reachable, and if not what do we
 * tell the author" and "how do we render pull progress" — are unit-testable. The
 * thin dockerode adapter probes the daemon and the VSCode shell shows the
 * notification / progress; those are verified by driving the extension. The
 * classifier is runtime-agnostic (a stopped Podman socket fails with the same
 * codes as Docker, and both stream identical Docker-Engine-API pull events);
 * only the remediation *wording* varies, so it is parameterized by a profile.
 */

/** Whether a runtime is reachable, and if not, which actionable state we are in. */
export type RuntimeAvailability =
  | { readonly kind: 'available' }
  /** No socket and no CLI on PATH — the runtime was never installed. */
  | { readonly kind: 'notInstalled' }
  /** The runtime is present but its daemon/service is not reachable — it is stopped. */
  | { readonly kind: 'notRunning' }
  /** An unrecognized failure (e.g. a permission error); `detail` is the raw message. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** Backwards-compatible alias for the pre-multi-runtime name. */
export type DockerAvailability = RuntimeAvailability;

/** The signals the thin dockerode adapter gathers for {@link classifyRuntimeProbe}. */
export interface RuntimeProbe {
  /** The error thrown by pinging the daemon, or `null`/`undefined` if it answered. */
  readonly pingError?: unknown;
  /**
   * Whether the runtime's CLI was found on PATH. A stronger signal that the
   * runtime is installed-but-stopped than the socket error alone: Docker Desktop
   * removes its managed socket when it stops, so an `ENOENT` from a machine that
   * clearly has the CLI means "not running", not "not installed". Optional — when
   * absent we classify from the socket error code alone.
   */
  readonly cliDetected?: boolean;
}

/**
 * Classify a daemon-ping outcome into an actionable availability. Pure: the thin
 * adapter supplies the ping error and (best-effort) CLI signal; this decides.
 */
export function classifyRuntimeProbe(probe: RuntimeProbe): RuntimeAvailability {
  if (probe.pingError == null) return { kind: 'available' };

  // The CLI is on PATH but the daemon is unreachable → installed but stopped.
  // This wins over the raw socket code, which can read as "not installed".
  if (probe.cliDetected) return { kind: 'notRunning' };

  const code = errorCode(probe.pingError);
  // No socket file at all → nothing is installed to talk to.
  if (code === 'ENOENT') return { kind: 'notInstalled' };
  // Socket exists but nothing is accepting / it dropped us → the daemon is down.
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return { kind: 'notRunning' };
  }
  return { kind: 'unknown', detail: errorMessage(probe.pingError) };
}

/**
 * The action button a remediation offers, when there is one:
 * - `openUrl` sends the author to an external page (the install docs).
 * - `startRuntime` starts the already-installed runtime (Docker Desktop, a Podman
 *   machine, or a user service); the shell then waits for the daemon and
 *   continues into the preview. Whether this button is surfaced depends on the
 *   platform — the profile decides via its `startAction`.
 */
export type RuntimeRemediationAction =
  | { readonly kind: 'openUrl'; readonly label: string; readonly url: string }
  | { readonly kind: 'startRuntime'; readonly label: string };

/** An actionable notification for a non-available runtime state. */
export interface RuntimeRemediation {
  /** One-sentence, actionable summary shown in the notification. */
  readonly message: string;
  /** Primary action button, when there is a concrete fix to offer. */
  readonly action?: RuntimeRemediationAction;
}

/** The profile fields {@link runtimeRemediation} needs to word its message. */
export type RemediationProfile = Pick<ContainerRuntimeProfile, 'displayName' | 'installUrl'>;

/**
 * The actionable message (and optional action button) for a non-available runtime
 * state, or `undefined` when it is available — nothing to remediate. The shell
 * shows this instead of proceeding into a cryptic socket error. `startLabel` is
 * the profile's platform-specific start action label (e.g. "Start Docker Desktop"
 * / "Start Podman machine"); when omitted, the "not running" message falls back
 * to manual guidance with no button.
 */
export function runtimeRemediation(
  availability: RuntimeAvailability,
  profile: RemediationProfile,
  startLabel?: string,
): RuntimeRemediation | undefined {
  const { displayName, installUrl } = profile;
  switch (availability.kind) {
    case 'available':
      return undefined;
    case 'notInstalled':
      return {
        message: `${displayName} is required to render previews, but it was not found. Install ${displayName}, then run the preview again.`,
        action: installUrl ? { kind: 'openUrl', label: `Install ${displayName}`, url: installUrl } : undefined,
      };
    case 'notRunning':
      return {
        message: `${displayName} is installed but not running. Start ${displayName}, then run the preview again.`,
        action: startLabel ? { kind: 'startRuntime', label: startLabel } : undefined,
      };
    case 'unknown':
      return {
        message: `Could not reach ${displayName}: ${availability.detail}. Make sure ${displayName} is installed and running, then run the preview again.`,
      };
  }
}

/**
 * Best-effort check for one of `names` on PATH — a signal that a runtime is
 * installed (so an unreachable daemon means "not running", not "not installed").
 * Scans PATH rather than spawning so it stays cheap and side-effect-free. On
 * Windows the executable extensions are tried too.
 */
export function detectCli(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const candidates =
    platform === 'win32' ? names.flatMap((name) => [`${name}.exe`, `${name}.com`, name]) : names;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch {
        /* unreadable PATH entry; keep scanning */
      }
    }
  }
  return false;
}

/** One progress event from a dockerode image pull. */
export interface DockerPullEvent {
  /** The layer phase, e.g. `Downloading`, `Extracting`, `Pull complete`. */
  readonly status?: string;
  /** The layer id the event concerns, when it is layer-scoped. */
  readonly id?: string;
  /** Byte counters for a measurable phase (download/extract). */
  readonly progressDetail?: { readonly current?: number; readonly total?: number };
}

/**
 * Turn a dockerode pull-progress event into a short human status line for the
 * "Pulling preview image…" progress notification, or `undefined` for an event
 * with nothing worth showing. A layer with a known total is rendered as a
 * clamped percentage so the one-time download reads as progressing, not stuck.
 */
export function formatPullStatus(event: DockerPullEvent): string | undefined {
  const status = event.status?.trim();
  if (!status) return undefined;

  const { current, total } = event.progressDetail ?? {};
  const label = event.id ? `${status} ${event.id}` : status;
  if (typeof current === 'number' && typeof total === 'number' && total > 0) {
    return `${label} — ${clampPercent((current / total) * 100)}%`;
  }
  return label;
}

/** Clamp a raw percentage into a whole number in `[0, 100]`. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** The aggregate download progress across all layers of an in-flight pull. */
export interface PullProgressSnapshot {
  /** Overall download percentage across sized layers, or `undefined` until any total is known. */
  readonly percent?: number;
  /** Layers that have finished pulling (including cached "Already exists" layers). */
  readonly layersDone: number;
  /** Distinct layers the pull has announced so far. */
  readonly layersTotal: number;
}

/** Per-layer download tally the {@link PullProgressAggregator} folds events into. */
interface LayerDownload {
  current: number;
  total: number;
  done: boolean;
}

/**
 * Folds a stream of dockerode pull events into an overall download percentage, so
 * the "Starting preview…" stepper can show one moving number instead of the
 * per-layer churn `formatPullStatus` emits for the log.
 *
 * Keyed by layer `id`, it counts **download** bytes only — the network transfer is
 * the slow part; extraction is fast and reports the far larger *uncompressed* size,
 * so folding its total in would corrupt the denominator. A layer therefore only
 * enters the percentage once a `Downloading` event reveals its compressed total,
 * and later phases (`Extracting`, `Pull complete`, …) only ever mark it complete.
 */
export class PullProgressAggregator {
  private readonly layers = new Map<string, LayerDownload>();

  /** Fold one event in and return the current aggregate. Events without an `id` are ignored. */
  add(event: DockerPullEvent): PullProgressSnapshot {
    const id = event.id;
    if (id) {
      const layer = this.ensureLayer(id);
      const status = event.status?.trim() ?? '';
      const { current, total } = event.progressDetail ?? {};
      if (/^Downloading/i.test(status)) {
        // Compressed size, streamed incrementally; this is the only phase that
        // may set the denominator.
        if (typeof total === 'number' && total > 0) {
          layer.total = total;
          if (typeof current === 'number') layer.current = current;
        }
      } else if (/^(Extracting|Verifying Checksum|Download complete)/i.test(status)) {
        // Fully downloaded — top the bytes off, but never trust these totals.
        if (layer.total > 0) layer.current = layer.total;
      } else if (/^(Pull complete|Already exists)/i.test(status)) {
        layer.done = true;
        if (layer.total > 0) layer.current = layer.total;
      }
    }
    return this.snapshot();
  }

  private ensureLayer(id: string): LayerDownload {
    let layer = this.layers.get(id);
    if (!layer) {
      layer = { current: 0, total: 0, done: false };
      this.layers.set(id, layer);
    }
    return layer;
  }

  private snapshot(): PullProgressSnapshot {
    let sumCurrent = 0;
    let sumTotal = 0;
    let layersDone = 0;
    for (const layer of this.layers.values()) {
      if (layer.done) layersDone += 1;
      if (layer.total > 0) {
        sumCurrent += layer.current;
        sumTotal += layer.total;
      }
    }
    return {
      percent: sumTotal > 0 ? clampPercent((sumCurrent / sumTotal) * 100) : undefined,
      layersDone,
      layersTotal: this.layers.size,
    };
  }
}

/** The `code` string a Node socket/system error carries, if any. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A human message for an error, falling back to its string form. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
