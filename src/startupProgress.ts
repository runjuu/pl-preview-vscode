/**
 * The overview-progress model for a cold-start preview, and its pure mapping into
 * a display view.
 *
 * A dependency-free leaf (like `previewUrl.ts` / `previewTarget.ts`) so every
 * layer can share the contract without a cycle: the dockerode adapter
 * (`dockerRuntime.ts`) reports {@link PreviewStartupProgress} up through the
 * `ensureRunning` port, the controller (`previewController.ts`) carries it on the
 * `starting` view state, and the webview shell (`panel.ts` / `extension.ts`) turns
 * it into the live "Starting preview…" stepper via {@link describeStartupProgress}.
 * Keeping the phase→step mapping here (not in the inline webview script) is what
 * makes the copy unit-testable.
 */

/**
 * A single point-in-time snapshot of where a cold start is. The three phases run
 * in order; only the first-use image pull carries measurable detail — a smooth
 * overall download percentage and how many layers have landed (the container start
 * and the readiness wait are indeterminate).
 */
export type PreviewStartupProgress =
  /** First-use image download, reported as real download progress. */
  | {
      readonly phase: 'pullingImage';
      /** Smooth overall download completion (0–100) across every layer. */
      readonly percent?: number;
      readonly layersDone?: number;
      readonly layersTotal?: number;
      /** The latest raw Docker pull status line, e.g. `Extracting f957de186774`. */
      readonly detail?: string;
    }
  /** The image is present; the container is being created and started. */
  | { readonly phase: 'startingContainer' }
  /** The container is up; we are polling until the preview server answers. */
  | { readonly phase: 'waitingForServer'; readonly elapsedMs: number; readonly timeoutMs: number };

/** One row of the startup stepper. */
export type StartupStepStatus = 'done' | 'active' | 'pending';
export interface StartupStep {
  readonly label: string;
  readonly status: StartupStepStatus;
  /** Short trailing detail on the active step (e.g. `"45%"`, `"3/8 layers"`, `"6s"`). */
  readonly note?: string;
}

/** The display shape the "Starting preview…" doc renders (initial paint + live updates). */
export interface StartupProgressView {
  readonly heading: string;
  /** Determinate bar width (0–100), or `undefined` for the indeterminate animation. */
  readonly percent?: number;
  /** The latest raw Docker status line, shown under the stepper during a pull. */
  readonly detail?: string;
  /** Exactly three rows, in fixed order (download → start → wait). */
  readonly steps: readonly StartupStep[];
}

const STARTING_HEADING = 'Starting preview…';

/** The three startup phases, in order; the index doubles as the stepper row order. */
const STEP_LABELS = ['Downloading image', 'Starting container', 'Launching preview server'] as const;
const PHASE_INDEX: Record<PreviewStartupProgress['phase'], number> = {
  pullingImage: 0,
  startingContainer: 1,
  waitingForServer: 2,
};

/**
 * Map a startup snapshot to the stepper view. Steps before the active phase read
 * `done`, the current phase `active`, later phases `pending`. `undefined` (the
 * initial "starting" state before any event) falls back to the first step being
 * `active`, so there is always exactly one step spinning its loading indicator.
 * Only the image pull contributes a `percent`. A cached image jumps straight to
 * `startingContainer`, so the download step reads `done` without ever having been
 * `active` — accurate enough, and simpler than threading "did a pull happen"
 * history through the view.
 */
export function describeStartupProgress(progress?: PreviewStartupProgress): StartupProgressView {
  const activeIndex = progress ? PHASE_INDEX[progress.phase] : 0;
  const note = activeStepNote(progress);
  const steps = STEP_LABELS.map((label, index): StartupStep => {
    const status: StartupStepStatus =
      index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending';
    return status === 'active' && note ? { label, status, note } : { label, status };
  });
  return {
    heading: STARTING_HEADING,
    percent: progress?.phase === 'pullingImage' ? progress.percent : undefined,
    detail: progress?.phase === 'pullingImage' ? progress.detail : undefined,
    steps,
  };
}

/** The trailing detail for the active step, when the phase carries one. */
function activeStepNote(progress?: PreviewStartupProgress): string | undefined {
  if (!progress) return undefined;
  switch (progress.phase) {
    case 'pullingImage':
      // The smooth `percent` drives the bar; the note carries the concrete layer
      // count, which climbs as each concurrent download lands.
      if (progress.layersTotal) return `${progress.layersDone ?? 0}/${progress.layersTotal} layers`;
      return undefined;
    case 'startingContainer':
      return undefined;
    case 'waitingForServer':
      return `${Math.round(progress.elapsedMs / 1000)}s`;
  }
}
