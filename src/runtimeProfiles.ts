import path from 'node:path';

import type Docker from 'dockerode';

/**
 * Pure model of the container runtimes the extension can drive and how to reach
 * them. Every target runtime (Docker, Podman, and the Docker-compatible engines
 * behind Colima / Rancher Desktop / OrbStack) implements the *same* Docker Engine
 * API, so the extension keeps one dockerode adapter and only varies the endpoint
 * it connects to and the install/start guidance it shows. This module is the
 * runtime-specific knowledge — endpoint parsing, per-platform socket locations,
 * and launch commands — kept free of dockerode/VSCode I/O so it is unit-testable.
 * The imperative shell (`extension.ts`) resolves an endpoint from these profiles,
 * builds a dockerode client for it, and probes/launches accordingly.
 */

/** Which runtime a resolved endpoint belongs to. `custom` is a user-supplied endpoint. */
export type RuntimeId = 'docker' | 'podman' | 'custom';

/** A concrete place to reach a Docker-Engine-API server. */
export type RuntimeEndpoint =
  | { readonly kind: 'socket'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number; readonly protocol: 'http' | 'https' }
  | { readonly kind: 'ssh'; readonly host: string; readonly port: number; readonly username?: string };

/** The host facts the pure profile logic reads to synthesize endpoints and launch commands. */
export interface EndpointContext {
  readonly env: Record<string, string | undefined>;
  readonly platform: NodeJS.Platform;
  /** `os.homedir()` — where Docker Desktop's per-user socket lives. */
  readonly home: string;
  /** `$XDG_RUNTIME_DIR` — the rootless Podman socket's parent on Linux. */
  readonly xdgRuntimeDir?: string;
  /** `%ProgramFiles%` — where Docker Desktop is installed on Windows. */
  readonly programFiles?: string;
}

/**
 * How to start a runtime that is installed but not running.
 * - `launchApp`: fire-and-forget a GUI app (Docker Desktop) that keeps running;
 *   we watch briefly for an immediate failure, then poll the daemon.
 * - `runToCompletion`: a CLI command that returns when done (`podman machine
 *   start`, `systemctl --user start`); we await its exit — tolerating a non-zero
 *   code (e.g. "already running") — then poll the daemon.
 */
export interface RuntimeStartAction {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly mode: 'launchApp' | 'runToCompletion';
}

/** Everything runtime-specific: how to reach it, name it, install it, and start it. */
export interface ContainerRuntimeProfile {
  readonly id: RuntimeId;
  /** Human name for messages, e.g. "Docker" / "Podman". */
  readonly displayName: string;
  /** Executable names that signal the runtime is installed (PATH scan, no exec). */
  readonly cliNames: readonly string[];
  /** Where to send an author who needs to install this runtime. */
  readonly installUrl: string;
  /** Endpoint from this runtime's own env var (`DOCKER_HOST` / `CONTAINER_HOST`), if set. */
  envEndpoint(ctx: EndpointContext): RuntimeEndpoint | undefined;
  /** Platform well-known socket candidates, in probe order. */
  wellKnownEndpoints(ctx: EndpointContext): readonly RuntimeEndpoint[];
  /** How to start the runtime when it is installed but not running, or `undefined`. */
  startAction(ctx: EndpointContext): RuntimeStartAction | undefined;
}

/** Where to send an author who needs to install Docker. */
export const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-docker/';
/** Where to send an author who needs to install Podman. */
export const PODMAN_INSTALL_URL = 'https://podman.io/docs/installation';

/** Windows Docker Engine named pipe (the default when nothing else is configured). */
const WINDOWS_DOCKER_PIPE = '//./pipe/docker_engine';

/**
 * Parse a `DOCKER_HOST`/`CONTAINER_HOST`-style endpoint string into a
 * {@link RuntimeEndpoint}, or `undefined` when it is blank or unparseable. Mirrors
 * docker-modem's own scheme handling (`unix://`, `npipe://`, `tcp://`, `ssh://`)
 * so a value that works in `DOCKER_HOST` resolves the same way here; a bare
 * `host:port` is treated as `tcp://`.
 */
export function parseContainerHost(value: string | undefined): RuntimeEndpoint | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (raw.startsWith('unix://')) {
    const socketPath = raw.slice('unix://'.length);
    return socketPath ? { kind: 'socket', socketPath } : undefined;
  }
  if (raw.startsWith('npipe://')) {
    const socketPath = raw.slice('npipe://'.length) || WINDOWS_DOCKER_PIPE;
    return { kind: 'socket', socketPath };
  }

  // A bare absolute path (unix socket, UNC/Windows named pipe, or drive path) is
  // a socket — `podman machine inspect` and `docker context` emit exactly this,
  // so accept it without requiring the author to prepend a `unix://` scheme.
  if (raw.startsWith('/') || raw.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'socket', socketPath: raw };
  }

  // Everything else is a network endpoint; a bare `host:port` implies tcp.
  const withScheme = raw.includes('://') ? raw : `tcp://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (!url.hostname) return undefined;

  if (url.protocol === 'ssh:') {
    return {
      kind: 'ssh',
      host: url.hostname,
      port: url.port ? Number(url.port) : 22,
      username: url.username || undefined,
    };
  }
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const defaultPort = protocol === 'https' ? 2376 : 2375;
  return { kind: 'tcp', host: url.hostname, port: url.port ? Number(url.port) : defaultPort, protocol };
}

/**
 * Translate a resolved endpoint into dockerode constructor options that fully
 * determine the connection. Competing fields are set to `undefined` on purpose:
 * docker-modem seeds its own defaults from `DOCKER_HOST`, and `Object.assign`
 * lets these overwrite them — so a stray `DOCKER_HOST` in the environment can
 * never override an endpoint we deliberately selected (e.g. a Podman socket).
 */
export function dockerodeOptionsForEndpoint(endpoint: RuntimeEndpoint): Docker.DockerOptions {
  switch (endpoint.kind) {
    case 'socket':
      return { socketPath: endpoint.socketPath, host: undefined, port: undefined, protocol: undefined };
    case 'tcp':
      return { socketPath: undefined, host: endpoint.host, port: endpoint.port, protocol: endpoint.protocol };
    case 'ssh':
      return {
        socketPath: undefined,
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        protocol: 'ssh',
      };
  }
}

/** All well-known + env candidate endpoints for a profile, env first, in probe order. */
export function candidateEndpoints(
  profile: ContainerRuntimeProfile,
  ctx: EndpointContext,
): readonly RuntimeEndpoint[] {
  const env = profile.envEndpoint(ctx);
  return env ? [env, ...profile.wellKnownEndpoints(ctx)] : [...profile.wellKnownEndpoints(ctx)];
}

/** Docker (and the Docker-socket-compatible engines: Colima, Rancher Desktop, OrbStack). */
export const DOCKER_PROFILE: ContainerRuntimeProfile = {
  id: 'docker',
  displayName: 'Docker',
  cliNames: ['docker'],
  installUrl: DOCKER_INSTALL_URL,
  envEndpoint: (ctx) => parseContainerHost(ctx.env.DOCKER_HOST),
  wellKnownEndpoints: (ctx) => {
    if (ctx.platform === 'win32') {
      return [{ kind: 'socket', socketPath: WINDOWS_DOCKER_PIPE }];
    }
    // Mirror docker-modem's findDefaultUnixSocket: the per-user Docker Desktop
    // socket first, then the system-wide socket.
    return [
      { kind: 'socket', socketPath: path.join(ctx.home, '.docker', 'run', 'docker.sock') },
      { kind: 'socket', socketPath: '/var/run/docker.sock' },
    ];
  },
  startAction: (ctx) => {
    switch (ctx.platform) {
      case 'darwin':
        // `open -a Docker` launches Docker Desktop and returns immediately.
        return { label: 'Start Docker Desktop', command: 'open', args: ['-a', 'Docker'], mode: 'launchApp' };
      case 'win32': {
        const base = ctx.programFiles && ctx.programFiles.length > 0 ? ctx.programFiles : 'C:\\Program Files';
        return {
          label: 'Start Docker Desktop',
          command: `${base}\\Docker\\Docker\\Docker Desktop.exe`,
          args: [],
          mode: 'launchApp',
        };
      }
      default:
        // On Linux the engine is a privileged system service, not a GUI app.
        return undefined;
    }
  },
};

/** Podman: a rootless Linux socket, or a `podman machine` VM on macOS/Windows. */
export const PODMAN_PROFILE: ContainerRuntimeProfile = {
  id: 'podman',
  displayName: 'Podman',
  cliNames: ['podman'],
  installUrl: PODMAN_INSTALL_URL,
  // Podman publishes CONTAINER_HOST; a Podman user who exports DOCKER_HOST for
  // compatibility is honored too.
  envEndpoint: (ctx) => parseContainerHost(ctx.env.CONTAINER_HOST ?? ctx.env.DOCKER_HOST),
  wellKnownEndpoints: (ctx) => {
    // On macOS/Windows the `podman machine` socket path is provider/version
    // dependent and not reliably guessable — rely on CONTAINER_HOST / the setting.
    if (ctx.platform !== 'linux') return [];
    const endpoints: RuntimeEndpoint[] = [];
    if (ctx.xdgRuntimeDir) {
      endpoints.push({ kind: 'socket', socketPath: path.join(ctx.xdgRuntimeDir, 'podman', 'podman.sock') });
    }
    endpoints.push({ kind: 'socket', socketPath: '/run/podman/podman.sock' });
    return endpoints;
  },
  startAction: (ctx) => {
    switch (ctx.platform) {
      case 'darwin':
      case 'win32':
        // Boots the Podman VM; returns non-zero if it is already running (tolerated).
        return { label: 'Start Podman machine', command: 'podman', args: ['machine', 'start'], mode: 'runToCompletion' };
      case 'linux':
        return {
          label: 'Start Podman',
          command: 'systemctl',
          args: ['--user', 'start', 'podman.socket'],
          mode: 'runToCompletion',
        };
      default:
        return undefined;
    }
  },
};

/**
 * A user-supplied endpoint whose runtime we can't identify. It carries no CLI
 * names, install URL, or start action — the endpoint comes straight from
 * `plPreview.containerHost` (or `DOCKER_HOST`/`CONTAINER_HOST`), and its failures
 * are remediated by pointing the author back at that setting.
 */
export const CUSTOM_PROFILE: ContainerRuntimeProfile = {
  id: 'custom',
  displayName: 'the configured container runtime',
  cliNames: [],
  installUrl: '',
  envEndpoint: (ctx) => parseContainerHost(ctx.env.CONTAINER_HOST ?? ctx.env.DOCKER_HOST),
  wellKnownEndpoints: () => [],
  startAction: () => undefined,
};

/** The two auto-detectable runtimes, keyed by id. */
export const RUNTIME_PROFILES: Record<'docker' | 'podman', ContainerRuntimeProfile> = {
  docker: DOCKER_PROFILE,
  podman: PODMAN_PROFILE,
};
