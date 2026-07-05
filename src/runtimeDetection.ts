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
    return `${label} (${clampPercent((current / total) * 100)}%)`;
  }
  return label;
}

/** Clamp a raw percentage into a whole number in `[0, 100]`. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** A point-in-time view of an in-flight pull, as the real download progress Docker reports. */
export interface PullProgressSnapshot {
  /**
   * Overall download completion (0–100), averaged across every announced layer, or
   * `undefined` before the first layer is announced. Smooth and monotonic — each
   * layer's own byte fraction feeds it, and the denominator is the fixed layer set.
   */
  readonly percent?: number;
  /** Layers whose download has finished (including cached "Already exists" layers). */
  readonly layersDone: number;
  /** Distinct real layers the pull has announced so far. */
  readonly layersTotal: number;
}

/**
 * The per-layer phases a real pull event announces. The leading `Pulling from <repo>`
 * header is deliberately absent: it carries the *tag* as its `id`, so counting it
 * would be mistaking the reference for a layer.
 */
const LAYER_PHASE =
  /^(Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists|Retrying)/i;
/** The phases that mean a layer has finished downloading (extraction/cache included). */
const LAYER_DOWNLOADED =
  /^(Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/i;

/** Per-layer download tally the {@link PullProgressAggregator} folds events into. */
interface LayerDownload {
  current: number;
  total: number;
  downloaded: boolean;
}

/**
 * Folds a stream of dockerode pull events into the real image-download progress: one
 * smooth `percent`, plus how many layers have finished downloading.
 *
 * `percent` is the **average download fraction across layers, weighted equally**: a
 * layer contributes its download-byte fraction while transferring, or a full `1` once
 * it has finished downloading (or was cached). The denominator is the layer *count*,
 * which Docker announces up front (`Pulling fs layer` / `Waiting`) and never changes —
 * so the number is monotonic and cannot lurch backwards. Weighting by bytes instead
 * would slide backwards every time a large layer reveals its size mid-pull (Docker
 * only discloses a layer's compressed size when it *starts* downloading, ~3 at a time).
 *
 * `layersDone` counts layers that have finished *downloading* — not just those fully
 * extracted — so it climbs steadily as the concurrent transfers land, instead of
 * sitting at zero until the extraction burst at the very end.
 *
 * Only genuine per-layer events count (see {@link LAYER_PHASE}); the `Pulling from
 * <repo>` header's tag id is ignored so the layer count is honest. Within a layer only
 * `Downloading` sets the byte total: extraction reports the far larger *uncompressed*
 * size, so later phases only mark the layer downloaded, never resize it.
 */
export class PullProgressAggregator {
  private readonly layers = new Map<string, LayerDownload>();

  /** Fold one event in and return the current snapshot. Non-layer events are ignored. */
  add(event: DockerPullEvent): PullProgressSnapshot {
    const id = event.id;
    const status = event.status?.trim() ?? '';
    if (id && LAYER_PHASE.test(status)) {
      const layer = this.ensureLayer(id);
      if (/^Downloading/i.test(status)) {
        // Compressed size, streamed incrementally — the only phase that sizes a layer.
        const { current, total } = event.progressDetail ?? {};
        if (typeof total === 'number' && total > 0) {
          layer.total = total;
          if (typeof current === 'number') layer.current = current;
        }
      } else if (LAYER_DOWNLOADED.test(status)) {
        layer.downloaded = true;
        if (layer.total > 0) layer.current = layer.total;
      }
    }
    return this.snapshot();
  }

  private ensureLayer(id: string): LayerDownload {
    let layer = this.layers.get(id);
    if (!layer) {
      layer = { current: 0, total: 0, downloaded: false };
      this.layers.set(id, layer);
    }
    return layer;
  }

  private snapshot(): PullProgressSnapshot {
    let completion = 0;
    let layersDone = 0;
    for (const layer of this.layers.values()) {
      if (layer.downloaded) {
        completion += 1;
        layersDone += 1;
      } else if (layer.total > 0) {
        completion += Math.min(1, layer.current / layer.total);
      }
      // An announced-but-unstarted layer contributes 0 to the numerator while still
      // counting toward the fixed denominator, so a later size can't shrink the percent.
    }
    const layersTotal = this.layers.size;
    return {
      percent: layersTotal > 0 ? clampPercent((completion / layersTotal) * 100) : undefined,
      layersDone,
      layersTotal,
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
