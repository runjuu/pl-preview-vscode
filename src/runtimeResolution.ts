import type { RuntimeAvailability } from './runtimeDetection';
import {
  CUSTOM_PROFILE,
  type ContainerRuntimeProfile,
  DOCKER_PROFILE,
  type EndpointContext,
  PODMAN_PROFILE,
  type RuntimeEndpoint,
  parseContainerHost,
} from './runtimeProfiles';

/**
 * Pure resolution of *which* runtime endpoint the extension should connect to,
 * given the user's setting and the host environment, plus the async shell that
 * probes the ordered candidates and picks the first reachable one. Split so the
 * whole ordering decision (setting override → env → Docker socket → Podman socket)
 * is unit-testable without any real daemon: `runtimeCandidates` is pure, and
 * `resolveRuntimeSelection` takes an injected `probe` (a real `ping` in the
 * extension, a fake map in tests).
 */

/** The user's runtime configuration (from `plPreview.*` settings). */
export interface RuntimeConfig {
  readonly runtime: 'auto' | 'docker' | 'podman' | 'custom';
  /** `plPreview.containerHost` — an explicit endpoint override; blank when unset. */
  readonly containerHost: string;
}

/** One endpoint to try, tagged with the runtime it belongs to and where it came from. */
export interface RuntimeCandidate {
  readonly profile: ContainerRuntimeProfile;
  readonly endpoint: RuntimeEndpoint;
  readonly source: 'setting' | 'env' | 'wellKnown';
}

/** The ordered candidates to probe, or a configuration error to show instead. */
export type RuntimeCandidates =
  | { readonly kind: 'candidates'; readonly candidates: readonly RuntimeCandidate[] }
  | { readonly kind: 'configError'; readonly message: string };

/**
 * Resolve the ordered list of endpoints to probe. Pure. Order:
 * - `custom` → the `containerHost` setting (or `DOCKER_HOST`/`CONTAINER_HOST`);
 *   blank/unparseable → a config error.
 * - `docker` / `podman` → that runtime's env endpoint then its well-known sockets
 *   (Podman with no socket on macOS/Windows → a config error pointing at the setting).
 * - `auto` → an explicit `containerHost` wins outright; otherwise Docker's
 *   candidates then Podman's, so a reachable Docker wins a tie and a Podman-only
 *   machine still resolves.
 */
export function runtimeCandidates(config: RuntimeConfig, ctx: EndpointContext): RuntimeCandidates {
  switch (config.runtime) {
    case 'custom':
      return customCandidates(config, ctx);
    case 'docker':
      return { kind: 'candidates', candidates: profileCandidates(DOCKER_PROFILE, ctx) };
    case 'podman': {
      const candidates = profileCandidates(PODMAN_PROFILE, ctx);
      return candidates.length > 0
        ? { kind: 'candidates', candidates }
        : { kind: 'configError', message: podmanNoSocketMessage() };
    }
    case 'auto': {
      // An explicit endpoint setting overrides auto-detection entirely.
      if (config.containerHost.trim()) return customCandidates(config, ctx);
      return {
        kind: 'candidates',
        candidates: [...profileCandidates(DOCKER_PROFILE, ctx), ...profileCandidates(PODMAN_PROFILE, ctx)],
      };
    }
  }
}

/** The outcome of probing the resolved candidates. */
export type RuntimeSelection =
  | { readonly kind: 'available'; readonly candidate: RuntimeCandidate }
  | {
      readonly kind: 'unavailable';
      readonly candidate: RuntimeCandidate;
      readonly availability: RuntimeAvailability;
    }
  | { readonly kind: 'configError'; readonly message: string };

/**
 * Probe the resolved candidates in order and return the first reachable one. If
 * none are reachable, return the most *actionable* failure so the shell can offer
 * a concrete fix: an installed-but-stopped runtime (`notRunning`) beats a missing
 * one (`notInstalled`) beats an opaque error (`unknown`), ties broken by
 * candidate order (Docker before Podman). `probe` is injected so this is testable
 * without a real daemon.
 */
export async function resolveRuntimeSelection(
  config: RuntimeConfig,
  ctx: EndpointContext,
  probe: (candidate: RuntimeCandidate) => Promise<RuntimeAvailability>,
): Promise<RuntimeSelection> {
  const resolved = runtimeCandidates(config, ctx);
  if (resolved.kind === 'configError') return resolved;

  let best: { candidate: RuntimeCandidate; availability: RuntimeAvailability } | undefined;
  for (const candidate of resolved.candidates) {
    const availability = await probe(candidate);
    if (availability.kind === 'available') {
      return { kind: 'available', candidate };
    }
    if (!best || actionRank(availability) > actionRank(best.availability)) {
      best = { candidate, availability };
    }
  }

  if (!best) {
    // No candidates at all — only reachable for an internal misconfiguration,
    // since docker always yields a default socket and podman returns a configError.
    return { kind: 'configError', message: podmanNoSocketMessage() };
  }
  return { kind: 'unavailable', candidate: best.candidate, availability: best.availability };
}

/** Env endpoint (first) then well-known sockets, each tagged with its profile. */
function profileCandidates(profile: ContainerRuntimeProfile, ctx: EndpointContext): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  const env = profile.envEndpoint(ctx);
  if (env) candidates.push({ profile, endpoint: env, source: 'env' });
  for (const endpoint of profile.wellKnownEndpoints(ctx)) {
    candidates.push({ profile, endpoint, source: 'wellKnown' });
  }
  return candidates;
}

/** A single custom candidate from the setting (preferred) or the env fallback. */
function customCandidates(config: RuntimeConfig, ctx: EndpointContext): RuntimeCandidates {
  const fromSetting = config.containerHost.trim();
  const raw = fromSetting || (ctx.env.DOCKER_HOST ?? ctx.env.CONTAINER_HOST ?? '').trim();
  if (!raw) {
    return {
      kind: 'configError',
      message:
        'Set "plPreview.containerHost" to a container runtime endpoint (e.g. unix:///run/user/1000/podman/podman.sock) to use the "custom" runtime.',
    };
  }
  const endpoint = parseContainerHost(raw);
  if (!endpoint) {
    return {
      kind: 'configError',
      message: `Could not parse the container runtime endpoint "${raw}". Use a form like unix:///path.sock, tcp://host:port, or npipe:////./pipe/name.`,
    };
  }
  return {
    kind: 'candidates',
    candidates: [{ profile: CUSTOM_PROFILE, endpoint, source: fromSetting ? 'setting' : 'env' }],
  };
}

function podmanNoSocketMessage(): string {
  return 'Podman is selected, but its socket could not be located automatically. Start Podman (e.g. "podman machine start"), then set CONTAINER_HOST or "plPreview.containerHost" to its socket and run the preview again.';
}

/** Higher is more actionable, so the shell can offer the best remediation. */
function actionRank(availability: RuntimeAvailability): number {
  switch (availability.kind) {
    case 'notRunning':
      return 3;
    case 'notInstalled':
      return 2;
    case 'unknown':
      return 1;
    case 'available':
      return 0;
  }
}
