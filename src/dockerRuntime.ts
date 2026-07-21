import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import Docker from 'dockerode';

import {
  PREVIEW_LABEL,
  PREVIEW_COURSES_MOUNT,
  PREVIEW_WORKSPACE_CONTAINER_LABEL,
  PREVIEW_WORKSPACE_HOME_MOUNT,
  PREVIEW_WORKSPACE_HOME_ROOT_LABEL,
  buildPreviewContainerCreateOptions,
  type PreviewCourseMount,
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
import { deleteLocalPreviewSession, discoverLocalPreviewSession } from './previewServerContract';
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
 * endpoint and the runtime's `cliNames`. One container hosts one Standalone
 * Preview Server; courses are independently mounted and registered as Local
 * Preview Sessions. `stop(courseRoot)` closes only that session, while `stopAll`
 * owns the server lifecycle. The session warm-pool *policy* (LRU cap, idle
 * reaping, dispose-all) lives in the `PreviewController`.
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
   * Start (or reuse) the shared server and the course's Local Preview Session,
   * reporting cold-start progress (pull → start → readiness) through `onProgress`
   * so the shell can drive the "Starting preview…" overview.
   */
  ensureRunning(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<{ port: number; previewSessionId: string }>;
  /** Close one course's Local Preview Session (LRU eviction / idle reaping). */
  stop(courseRoot: string): Promise<void>;
  /** Close every session and stop the one server container. */
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
   * Course roots known before the server starts. Pre-registering them lets the
   * first container mount every course in a multi-course workspace at once.
   */
  courseRoots?: readonly string[];
  /**
   * When set, the preview server is granted workspace-question support: the
   * runtime socket is mounted, one shared network is created, and one
   * daemon-managed named volume is created and mounted to hold all session-owned
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

interface RunningServer {
  container: Docker.Container;
  port: number;
  courseRoots: ReadonlySet<string>;
  workspacesEnabled: boolean;
}

interface CreatedContainer {
  container: Docker.Container;
  courseRoots: ReadonlySet<string>;
  workspacesEnabled: boolean;
}

export class DockerPreviewRuntime implements PreviewRuntime {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly imageVersion: string | undefined;
  private readonly cliNames: readonly string[];
  private readonly log: (line: string) => void;
  private readonly workspaces: PreviewWorkspaceSupport | undefined;
  /** Optional control-plane credential, retained only in the extension host. */
  private readonly authToken = randomBytes(32).toString('base64url');
  /** Names this runtime's one server container and its shared workspace resources. */
  private readonly serverId = randomBytes(8).toString('hex');
  /** Host course root → private absolute course path inside the container. */
  private readonly courseDirs = new Map<string, string>();
  /** Course root → session id on the current server generation. */
  private readonly sessions = new Map<string, string>();
  private running: RunningServer | undefined;
  /** Serializes server replacement, session mutation, and shutdown. */
  private operations: Promise<void> = Promise.resolve();
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
    this.registerCourseRoots(options.courseRoots ?? []);
  }

  /**
   * Add course roots that should be mounted when the server next starts. This is
   * safe to call repeatedly as workspace discovery finds the same marker files.
   * A later, previously unknown course triggers one coordinated server restart,
   * because Docker cannot add bind mounts to an already-running container.
   */
  registerCourseRoots(courseRoots: readonly string[]): void {
    for (const courseRoot of courseRoots) {
      this.registerCourseRoot(courseRoot);
    }
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
      return classifyRuntimeProbe({
        pingError,
        cliDetected: detectCli(this.cliNames),
      });
    }
  }

  async ensureRunning(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<{ port: number; previewSessionId: string }> {
    const normalizedCourseRoot = this.registerCourseRoot(courseRoot);
    return this.runExclusive(async () => {
      let server = this.running;
      if (server && !server.courseRoots.has(normalizedCourseRoot)) {
        this.log(`[pl-preview] restarting preview server to mount ${normalizedCourseRoot}`);
        await this.stopServer(server, false);
        server = undefined;
      }
      server ??= await this.startServer(onProgress);

      const existing = this.sessions.get(normalizedCourseRoot);
      if (existing) {
        return { port: server.port, previewSessionId: existing };
      }

      const session = await discoverLocalPreviewSession({
        origin: previewOrigin(server.port),
        courseDir: this.courseDirs.get(normalizedCourseRoot)!,
        authToken: this.authToken,
        requireWorkspaces: server.workspacesEnabled,
      });
      this.sessions.set(normalizedCourseRoot, session.previewSessionId);
      this.log(
        `[pl-preview] preview session ready for ${normalizedCourseRoot} on 127.0.0.1:${server.port} (${session.previewSessionId})`,
      );
      return { port: server.port, previewSessionId: session.previewSessionId };
    });
  }

  async stop(courseRoot: string): Promise<void> {
    const normalizedCourseRoot = path.resolve(courseRoot);
    await this.runExclusive(async () => {
      const previewSessionId = this.sessions.get(normalizedCourseRoot);
      const server = this.running;
      if (!previewSessionId || !server) return;
      this.sessions.delete(normalizedCourseRoot);
      await this.deleteSession(server.port, previewSessionId);
    });
  }

  async stopAll(): Promise<void> {
    await this.runExclusive(async () => {
      const server = this.running;
      if (server) {
        await this.stopServer(server, true);
      } else {
        this.sessions.clear();
        await this.cleanupWorkspaceSupport();
      }
    });
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
  private async createContainer(onProgress?: (progress: PreviewStartupProgress) => void): Promise<CreatedContainer> {
    const workspaces = await this.prepareWorkspaceSupport(onProgress);
    const courseMounts = [...this.courseDirs].map(
      ([courseRoot, courseDir]): PreviewCourseMount => ({
        courseRoot,
        courseDir,
      }),
    );
    const courseRoots = new Set(courseMounts.map(({ courseRoot }) => courseRoot));
    const options = buildPreviewContainerCreateOptions({
      image: this.image,
      courseMounts,
      serverId: this.serverId,
      authToken: this.authToken,
      workspaces,
    });

    try {
      return {
        container: await this.docker.createContainer(options),
        courseRoots,
        workspacesEnabled: workspaces != null,
      };
    } catch (error) {
      if (!isNoSuchImage(error)) {
        throw error;
      }
      this.log(`[pl-preview] pulling ${this.image} (first use)…`);
      await this.pullImage(onProgress);
      return {
        container: await this.docker.createContainer(options),
        courseRoots,
        workspacesEnabled: workspaces != null,
      };
    }
  }

  /** Start one server generation with a snapshot of all currently known course mounts. */
  private async startServer(onProgress?: (progress: PreviewStartupProgress) => void): Promise<RunningServer> {
    const { container, courseRoots, workspacesEnabled } = await this.createContainer(onProgress);
    try {
      onProgress?.({
        phase: 'startingContainer',
        imageVersion: this.imageVersion,
      });
      await container.start();
      this.streamLogs(container);
      const inspect = await container.inspect();
      const port = resolvePublishedPort(inspect as unknown as PreviewContainerInspect);
      await this.waitForReady(port, onProgress);
      const server = { container, courseRoots, port, workspacesEnabled };
      this.running = server;
      this.log(
        `[pl-preview] shared preview server ready on 127.0.0.1:${port} (${courseRoots.size} course mount${courseRoots.size === 1 ? '' : 's'})`,
      );
      return server;
    } catch (error) {
      await this.forceRemove(container);
      throw error;
    }
  }

  private async pullImage(onProgress?: (progress: PreviewStartupProgress) => void): Promise<void> {
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

  /** Poll the public health endpoint until it returns the stable ready response. */
  private async waitForReady(port: number, onProgress?: (progress: PreviewStartupProgress) => void): Promise<void> {
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

  /** Best-effort explicit session cleanup; process shutdown remains the fallback. */
  private async deleteSession(port: number, previewSessionId: string): Promise<void> {
    try {
      await deleteLocalPreviewSession({
        origin: previewOrigin(port),
        previewSessionId,
        authToken: this.authToken,
      });
    } catch (error) {
      this.log(
        `[pl-preview] could not delete ${previewSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Close all current sessions and stop one server generation. */
  private async stopServer(server: RunningServer, cleanupWorkspaces: boolean): Promise<void> {
    const previewSessionIds = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(previewSessionIds.map((previewSessionId) => this.deleteSession(server.port, previewSessionId)));
    if (this.running === server) {
      this.running = undefined;
    }
    await this.gracefulRemove(server.container);
    if (cleanupWorkspaces) {
      await this.cleanupWorkspaceSupport();
    }
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
   * Prepare server-wide workspace support: ensure the shared network and named
   * home volume exist, then return the container-spec config. Local Preview
   * Sessions namespace their workspace ownership within these shared resources.
   */
  private async prepareWorkspaceSupport(
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

    const network = previewNetworkName(this.serverId);
    const volumeName = workspaceVolumeName(this.serverId);
    await this.ensureNetwork(network);
    // createVolume is idempotent: it returns the existing volume for a name that
    // already exists rather than erroring, so a warm re-open just reuses it.
    await this.docker.createVolume({
      Name: volumeName,
      Labels: { [PREVIEW_LABEL]: 'true' },
    });
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
      HostConfig: {
        Binds: [`${volume}:${PREVIEW_WORKSPACE_HOME_MOUNT}`],
        AutoRemove: true,
      },
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
        const version = (await this.docker.version()) as {
          ApiVersion?: string;
        };
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
   * Reap workspace containers the shared server left behind, remove its network,
   * then best-effort remove its named volume. The server reaps its own children
   * on a graceful stop; this is the backstop for a hard kill.
   */
  private async cleanupWorkspaceSupport(): Promise<void> {
    const support = this.workspaces;
    if (support == null) {
      return;
    }
    const volumeName = workspaceVolumeName(this.serverId);
    await this.reapWorkspaceContainers(volumeName);
    await this.removeNetwork(previewNetworkName(this.serverId));
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

  /** Add one normalized course root and return the key used by session state. */
  private registerCourseRoot(courseRoot: string): string {
    const normalizedCourseRoot = path.resolve(courseRoot);
    if (!this.courseDirs.has(normalizedCourseRoot)) {
      this.courseDirs.set(normalizedCourseRoot, `${PREVIEW_COURSES_MOUNT}/${previewCourseId(normalizedCourseRoot)}`);
    }
    return normalizedCourseRoot;
  }

  /** Run one lifecycle mutation after every earlier mutation, even if one failed. */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

/** Name of the server-wide network the preview and workspace containers share. */
export function previewNetworkName(serverId: string): string {
  return `pl-preview-net-${serverId}`;
}

/** Server-wide daemon-managed named volume holding session-scoped workspace homes. */
function workspaceVolumeName(serverId: string): string {
  return `pl-preview-workspaces-${serverId}`;
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
    const req = http.get(`${origin}/health`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            status?: unknown;
          };
          resolve(res.statusCode === 200 && body.status === 'ok');
        } catch {
          resolve(false);
        }
      });
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
function apiVersionAtLeast(apiVersion: string | undefined, [minMajor, minMinor]: readonly [number, number]): boolean {
  if (!apiVersion) return false;
  const [major, minor] = apiVersion.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}
