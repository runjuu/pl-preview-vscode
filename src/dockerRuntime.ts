import http from 'node:http';
import path from 'node:path';

import Docker from 'dockerode';

import {
  PREVIEW_LABEL,
  PREVIEW_WORKSPACE_CONTAINER_LABEL,
  PREVIEW_WORKSPACE_HOME_MOUNT,
  PREVIEW_WORKSPACE_HOME_ROOT_LABEL,
  buildPreviewContainerCreateOptions,
  type PreviewContainerInspect,
  type PreviewImageInfo,
  type PreviewWorkspaceContainerConfig,
  type RemovablePreviewImage,
  resolvePreviewImage,
  resolvePublishedPort,
  selectRemovablePreviewImages,
} from './containerSpec';
import {
  type DockerPullEvent,
  PullProgressAggregator,
  type RuntimeAvailability,
  classifyRuntimeProbe,
  detectCli,
  formatPullStatus,
} from './runtimeDetection';
import { previewOrigin } from './previewUrl';
import { previewImageVersion, type PreviewStartupProgress } from './startupProgress';

/**
 * Thin dockerode adapter: launches and tears down Local Preview Containers.
 *
 * This is the imperative shell around the pure `containerSpec` contract — it owns
 * the real Docker Engine API I/O (create/start/pull/inspect/logs/remove) and
 * readiness polling, and is deliberately *not* unit-tested (verified by driving
 * the extension). The API is the same for every supported runtime (Docker,
 * Podman, and the Docker-socket-compatible engines), so this one adapter serves
 * all of them — the shell just injects a `docker` client built for the resolved
 * endpoint and the runtime's `cliNames`. It keys containers by course root and
 * exposes `ensureRunning` / `stop` / `stopAll`; the warm-pool *policy* (LRU cap,
 * idle reaping, dispose-all) lives in the `PreviewController`, which drives these
 * ports.
 */

/** How the extension observes and controls preview containers. */
export interface PreviewRuntime {
  /**
   * Report whether the runtime's daemon is reachable, so the shell can guide a
   * first-run author (install/start the runtime) instead of proceeding into a
   * cryptic socket error.
   */
  checkAvailability(): Promise<RuntimeAvailability>;
  /**
   * Start (or reuse) the container for a course and return its loopback port,
   * reporting cold-start progress (pull → start → readiness) through `onProgress`
   * so the shell can drive the "Starting preview…" overview.
   */
  ensureRunning(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<{ port: number }>;
  /** Stop and remove the container for a single course (LRU eviction / idle reaping). */
  stop(courseRoot: string): Promise<void>;
  /** Stop every container this runtime started. */
  stopAll(): Promise<void>;
  /**
   * List the superseded preview images on the daemon — every image of the current
   * image's repository except the pinned one — so the shell can offer to reclaim the
   * disk each obsolete extension release left behind.
   */
  listRemovablePreviewImages(): Promise<RemovablePreviewImage[]>;
  /** Remove a single image by id; the caller handles a still-in-use failure per image. */
  removePreviewImage(id: string): Promise<void>;
}

export interface DockerPreviewRuntimeOptions {
  /** Pinned preview-server image; defaults to {@link resolvePreviewImage}. */
  image?: string;
  /** Injectable dockerode client (defaults to the local Docker socket). */
  docker?: Docker;
  /**
   * CLI executable names that signal the runtime is installed, used by
   * {@link DockerPreviewRuntime.checkAvailability} to tell "installed but stopped"
   * apart from "not installed". Defaults to `['docker']`.
   */
  cliNames?: readonly string[];
  /** Sink for container stdout/stderr and lifecycle notes (Output channel in prod). */
  log?: (line: string) => void;
  /**
   * When set, preview containers are granted workspace-question support: the
   * runtime socket is mounted, a per-course shared network is created, and a
   * per-course daemon-managed named volume is created and mounted to hold the
   * workspace home dirs. Absent when the workspace is untrusted or the resolved
   * endpoint is not socket-based.
   */
  workspaces?: PreviewWorkspaceSupport;
}

/** Host-side inputs for granting a preview container workspace support. */
export interface PreviewWorkspaceSupport {
  /** Host path of the runtime socket, bind-mounted so the server can launch containers. */
  dockerSocketPath: string;
  /**
   * Supplementary gid the non-root container user joins to open the mounted
   * socket: the socket's real group on native Linux, or group 0 on VM-backed
   * runtimes (Docker Desktop et al.) that re-present it as root:root.
   */
  socketGid?: number;
}

const READINESS_ATTEMPTS = 120;
const READINESS_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1_000;

/**
 * SIGTERM grace given to a preview container on stop so its own shutdown handler
 * can reap the workspace containers it launched before Docker force-kills it.
 */
const STOP_TIMEOUT_SECONDS = 10;

interface RunningContainer {
  container: Docker.Container;
  port: number;
}

export class DockerPreviewRuntime implements PreviewRuntime {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly imageVersion: string | undefined;
  private readonly cliNames: readonly string[];
  private readonly log: (line: string) => void;
  private readonly workspaces: PreviewWorkspaceSupport | undefined;
  private readonly running = new Map<string, RunningContainer>();
  /**
   * Cached daemon capability check: whether the Engine supports per-workspace
   * volume subpath mounts (VolumeOptions.Subpath, API >= 1.45). Resolved lazily on
   * first workspace launch; undefined until then.
   */
  private workspaceVolumesSupported: boolean | undefined;

  constructor(options: DockerPreviewRuntimeOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.image = options.image ?? resolvePreviewImage();
    this.imageVersion = previewImageVersion(this.image);
    this.cliNames = options.cliNames ?? ['docker'];
    this.log = options.log ?? (() => {});
    this.workspaces = options.workspaces;
  }

  /**
   * Ping the runtime's daemon and classify the outcome. When the ping fails we add
   * a best-effort "is the runtime's CLI on PATH" signal so a stopped daemon (CLI
   * present, socket gone) is reported as "not running" rather than "not
   * installed". The classification decision itself is the pure
   * {@link classifyRuntimeProbe}.
   */
  async checkAvailability(): Promise<RuntimeAvailability> {
    try {
      await this.docker.ping();
      return { kind: 'available' };
    } catch (pingError) {
      return classifyRuntimeProbe({ pingError, cliDetected: detectCli(this.cliNames) });
    }
  }

  async ensureRunning(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<{ port: number }> {
    const existing = this.running.get(courseRoot);
    if (existing) {
      return { port: existing.port };
    }

    const container = await this.createContainer(courseRoot, onProgress);
    try {
      onProgress?.({ phase: 'startingContainer', imageVersion: this.imageVersion });
      await container.start();
      this.streamLogs(container);
      const inspect = await container.inspect();
      const port = resolvePublishedPort(inspect as unknown as PreviewContainerInspect);
      await this.waitForReady(port, onProgress);
      this.running.set(courseRoot, { container, port });
      this.log(`[pl-preview] preview ready for ${courseRoot} on 127.0.0.1:${port}`);
      return { port };
    } catch (error) {
      await this.forceRemove(container);
      throw error;
    }
  }

  async stop(courseRoot: string): Promise<void> {
    const running = this.running.get(courseRoot);
    if (!running) {
      return;
    }
    this.running.delete(courseRoot);
    await this.gracefulRemove(running.container);
    await this.cleanupWorkspaceSupport(courseRoot);
  }

  async stopAll(): Promise<void> {
    const courseRoots = [...this.running.keys()];
    const containers = [...this.running.values()];
    this.running.clear();
    await Promise.all(containers.map(({ container }) => this.gracefulRemove(container)));
    await Promise.all(courseRoots.map((courseRoot) => this.cleanupWorkspaceSupport(courseRoot)));
  }

  async listRemovablePreviewImages(): Promise<RemovablePreviewImage[]> {
    const images = (await this.docker.listImages()) as unknown as PreviewImageInfo[];
    return selectRemovablePreviewImages(images, this.image);
  }

  async removePreviewImage(id: string): Promise<void> {
    // `force` clears an image that still carries multiple tags; an image bound to a
    // running container throws a 409, which the caller surfaces as "skipped".
    await this.docker.getImage(id).remove({ force: true });
  }

  /**
   * Create the container, pulling the pinned image on the first-use "No such
   * image" 404. The pull reports real per-layer download progress through
   * `onProgress` so the shell can show it in the "Starting preview…" overview.
   */
  private async createContainer(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<Docker.Container> {
    const options = buildPreviewContainerCreateOptions({
      image: this.image,
      courseRoot,
      courseId: previewCourseId(courseRoot),
      workspaces: await this.prepareWorkspaceSupport(courseRoot, onProgress),
    });

    try {
      return await this.docker.createContainer(options);
    } catch (error) {
      if (!isNoSuchImage(error)) {
        throw error;
      }
      this.log(`[pl-preview] pulling ${this.image} (first use)…`);
      await this.pullImage(onProgress);
      return this.docker.createContainer(options);
    }
  }

  private async pullImage(
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<void> {
    const aggregate = new PullProgressAggregator();
    const stream = await this.docker.pull(this.image);
    await new Promise<void>((resolve, reject) => {
      // The latest human-readable status line, echoed both to the Output channel and
      // onto the panel so the user sees exactly what Docker is doing. Events with
      // nothing worth showing leave the previous line in place rather than blanking it.
      let detail: string | undefined;
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event) => {
          const pullEvent = event as DockerPullEvent;
          const status = formatPullStatus(pullEvent);
          if (status) {
            this.log(`[pl-preview] ${status}`);
            detail = status;
          }
          const { percent, layersDone, layersTotal } = aggregate.add(pullEvent);
          onProgress?.({
            phase: 'pullingImage',
            percent,
            layersDone,
            layersTotal,
            detail,
            imageVersion: this.imageVersion,
          });
        },
      );
    });
  }

  /** Poll `GET /` until the preview server answers any HTTP response. */
  private async waitForReady(
    port: number,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<void> {
    const origin = previewOrigin(port);
    const timeoutMs = READINESS_ATTEMPTS * READINESS_INTERVAL_MS;
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      onProgress?.({
        phase: 'waitingForServer',
        elapsedMs: attempt * READINESS_INTERVAL_MS,
        timeoutMs,
        imageVersion: this.imageVersion,
      });
      if (await probe(origin)) {
        return;
      }
      await delay(READINESS_INTERVAL_MS);
    }
    throw new Error(`Preview server on ${origin} did not become ready in time`);
  }

  private streamLogs(container: Docker.Container): void {
    container
      .logs({ follow: true, stdout: true, stderr: true, tail: 0 })
      .then((stream) => {
        const sink = (chunk: Buffer) => {
          const text = chunk.toString('utf8').replace(/\s+$/, '');
          if (text) {
            this.log(text);
          }
        };
        // Non-TTY logs are multiplexed; demux stdout/stderr into the same sink.
        const stdout = { write: sink } as unknown as NodeJS.WritableStream;
        const stderr = { write: sink } as unknown as NodeJS.WritableStream;
        this.docker.modem.demuxStream(stream, stdout, stderr);
      })
      .catch(() => {
        /* best-effort log streaming into the Output channel (revealed by "Show logs") */
      });
  }

  private async forceRemove(container: Docker.Container): Promise<void> {
    try {
      await container.remove({ force: true });
    } catch {
      /* container may already be gone (AutoRemove); ignore */
    }
  }

  /**
   * Stop the container with a SIGTERM grace period before removing it, so the
   * preview server's shutdown handler can reap the workspace containers it
   * launched. `stop` auto-removes an AutoRemove container, so the follow-up
   * force-remove just mops up if the stop raced or timed out.
   */
  private async gracefulRemove(container: Docker.Container): Promise<void> {
    try {
      await container.stop({ t: STOP_TIMEOUT_SECONDS });
    } catch {
      /* already stopped, gone, or never started */
    }
    await this.forceRemove(container);
  }

  /**
   * Prepare per-course workspace support: ensure the shared network and a
   * daemon-managed named volume for the workspace home dirs exist, then return
   * the container-spec config. Returns undefined when workspace support is
   * disabled for this session.
   */
  private async prepareWorkspaceSupport(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<PreviewWorkspaceContainerConfig | undefined> {
    const support = this.workspaces;
    if (support == null) {
      return undefined;
    }

    // Per-workspace isolation relies on VolumeOptions.Subpath (Engine 25.0 / API
    // 1.45). An older daemon silently ignores the field and mounts the whole
    // volume root into every workspace, cross-contaminating their home dirs — so
    // degrade to no-workspaces (ordinary questions still render) instead.
    if (!(await this.supportsWorkspaceVolumes())) {
      this.log(
        '[pl-preview] workspace questions disabled: Docker Engine is older than 25.0 ' +
          '(API 1.45), required for per-workspace volume mounts',
      );
      return undefined;
    }

    const network = previewNetworkName(previewCourseId(courseRoot));
    const volumeName = workspaceVolumeName(courseRoot);
    await this.ensureNetwork(network);
    // createVolume is idempotent: it returns the existing volume for a name that
    // already exists rather than erroring, so a warm re-open just reuses it.
    await this.docker.createVolume({ Name: volumeName, Labels: { [PREVIEW_LABEL]: 'true' } });
    await this.chownVolumeRoot(volumeName, onProgress);

    return {
      // On Windows the dockerode client talks over the named pipe, but the
      // daemon-side bind source must be the real Unix socket inside the VM.
      dockerSocketPath: daemonSocketMountSource(support.dockerSocketPath),
      network,
      homeVolume: volumeName,
      socketGid: support.socketGid,
    };
  }

  /**
   * A fresh named volume's root is created `root:root` mode 0755, but the preview
   * server runs as uid 1001 and must populate workspace home dirs under it. Run a
   * throwaway root container that binds the volume and `chmod 0777`s its root so
   * the non-root user can write. On a cold first run the image may not be pulled
   * yet, so a no-such-image 404 triggers a pull-and-retry.
   */
  private async chownVolumeRoot(
    volume: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<void> {
    const options: Docker.ContainerCreateOptions = {
      Image: this.image,
      User: '0:0',
      Entrypoint: ['chmod', '0777', PREVIEW_WORKSPACE_HOME_MOUNT],
      // Label + AutoRemove so a crash between start and the finally-remove can't
      // leak this throwaway container: the daemon reaps it on exit, and the label
      // lets any future reconciliation find it.
      Labels: { [PREVIEW_LABEL]: 'true' },
      HostConfig: { Binds: [`${volume}:${PREVIEW_WORKSPACE_HOME_MOUNT}`], AutoRemove: true },
    };

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(options);
    } catch (error) {
      if (!isNoSuchImage(error)) {
        throw error;
      }
      this.log(`[pl-preview] pulling ${this.image} (first use)…`);
      await this.pullImage(onProgress);
      container = await this.docker.createContainer(options);
    }

    try {
      await container.start();
      try {
        // Block until the (near-instant) chmod finishes so the preview container
        // never mounts the volume before its root is writable. With AutoRemove the
        // daemon may reap the exited container before wait() resolves; that shows
        // up as "no such container" and is benign — a start() failure is not.
        await container.wait();
      } catch (error) {
        if (!isNoSuchContainer(error)) {
          throw error;
        }
      }
    } finally {
      await this.forceRemove(container);
    }
  }

  /**
   * Whether the daemon supports per-workspace volume subpath mounts
   * (VolumeOptions.Subpath, Engine 25.0 / API 1.45). Cached after the first probe;
   * a daemon that won't report a version is treated as unsupported so we degrade
   * safely rather than risk a silent whole-volume mount.
   */
  private async supportsWorkspaceVolumes(): Promise<boolean> {
    if (this.workspaceVolumesSupported === undefined) {
      try {
        const version = (await this.docker.version()) as { ApiVersion?: string };
        this.workspaceVolumesSupported = apiVersionAtLeast(version.ApiVersion, MIN_SUBPATH_API_VERSION);
      } catch {
        this.workspaceVolumesSupported = false;
      }
    }
    return this.workspaceVolumesSupported;
  }

  private async ensureNetwork(name: string): Promise<void> {
    try {
      await this.docker.createNetwork({ Name: name, CheckDuplicate: true });
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
      /* the network already exists — reuse it */
    }
  }

  /**
   * Reap any workspace containers this course's preview server left behind,
   * remove its now-unused network, then best-effort remove its named volume. The
   * preview server reaps its own children on a graceful stop; this is the
   * backstop for a hard kill.
   */
  private async cleanupWorkspaceSupport(courseRoot: string): Promise<void> {
    const support = this.workspaces;
    if (support == null) {
      return;
    }
    const volumeName = workspaceVolumeName(courseRoot);
    await this.reapWorkspaceContainers(volumeName);
    await this.removeNetwork(previewNetworkName(previewCourseId(courseRoot)));
    try {
      await this.docker.getVolume(volumeName).remove({ force: true });
    } catch {
      /* still in use by a lingering container, or already gone */
    }
  }

  private async reapWorkspaceContainers(homeRootLabel: string): Promise<void> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${PREVIEW_WORKSPACE_CONTAINER_LABEL}=true`] },
      });
      await Promise.all(
        containers
          .filter((info) => info.Labels?.[PREVIEW_WORKSPACE_HOME_ROOT_LABEL] === homeRootLabel)
          .map((info) => this.forceRemove(this.docker.getContainer(info.Id))),
      );
    } catch {
      /* best-effort: the server also prunes its own orphans on next startup */
    }
  }

  private async removeNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).remove();
    } catch {
      /* still in use by another container, or already gone */
    }
  }
}

/** Reuse a stable course id from the folder name, plus a short path hash for uniqueness. */
export function previewCourseId(courseRoot: string): string {
  const base = path.basename(courseRoot).replace(/[^a-zA-Z0-9_.-]/g, '-') || 'course';
  let hash = 0;
  for (const char of courseRoot) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return `${base}-${(hash >>> 0).toString(36)}`;
}

/** Name of the per-course user-defined network the preview and workspace containers share. */
export function previewNetworkName(courseId: string): string {
  return `pl-preview-net-${courseId}`;
}

/** Per-course daemon-managed named volume holding the workspace home dirs. */
function workspaceVolumeName(courseRoot: string): string {
  return `pl-preview-workspaces-${previewCourseId(courseRoot)}`;
}

/**
 * The bind source the daemon uses for the runtime socket. On Windows the
 * dockerode client reaches the daemon over the `//./pipe/docker_engine` named
 * pipe, but a bind mount's source is resolved inside the Docker Desktop VM,
 * where the real Unix socket lives at `/var/run/docker.sock`. On every other
 * platform the client socket path is itself bindable, so it passes through.
 */
function daemonSocketMountSource(clientSocketPath: string): string {
  return process.platform === 'win32' ? '/var/run/docker.sock' : clientSocketPath;
}

function isConflict(error: unknown): boolean {
  return (error as { statusCode?: number } | undefined)?.statusCode === 409;
}

function probe(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${origin}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoSuchImage(error: unknown): boolean {
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return status === 404 || /no such image/i.test(message);
}

function isNoSuchContainer(error: unknown): boolean {
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return status === 404 || /no such container|already in progress/i.test(message);
}

/** Minimum Docker Engine API version for VolumeOptions.Subpath (Engine 25.0). */
const MIN_SUBPATH_API_VERSION: readonly [number, number] = [1, 45];

/** True when a `major.minor` Docker API version string is >= the given floor. */
function apiVersionAtLeast(
  apiVersion: string | undefined,
  [minMajor, minMinor]: readonly [number, number],
): boolean {
  if (!apiVersion) return false;
  const [major, minor] = apiVersion.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}
