import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import Docker from 'dockerode';

import {
  PREVIEW_WORKSPACE_CONTAINER_LABEL,
  PREVIEW_WORKSPACE_HOME_ROOT_LABEL,
  buildPreviewContainerCreateOptions,
  type PreviewContainerInspect,
  type PreviewWorkspaceContainerConfig,
  resolvePreviewImage,
  resolvePublishedPort,
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
import type { PreviewStartupProgress } from './startupProgress';

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
   * per-course writable home dir under {@link PreviewWorkspaceSupport.homeRoot}
   * is bind-mounted. Absent when the workspace is untrusted or the resolved
   * endpoint is not socket-based.
   */
  workspaces?: PreviewWorkspaceSupport;
}

/** Host-side inputs for granting a preview container workspace support. */
export interface PreviewWorkspaceSupport {
  /** Host path of the runtime socket, bind-mounted so the server can launch containers. */
  dockerSocketPath: string;
  /** Base host dir under which per-course writable workspace home roots are created. */
  homeRoot: string;
  /** Supplementary gid for socket access (Linux); omit on Docker Desktop/macOS. */
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
  private readonly cliNames: readonly string[];
  private readonly log: (line: string) => void;
  private readonly workspaces: PreviewWorkspaceSupport | undefined;
  private readonly running = new Map<string, RunningContainer>();

  constructor(options: DockerPreviewRuntimeOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.image = options.image ?? resolvePreviewImage();
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
      onProgress?.({ phase: 'startingContainer' });
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

  /**
   * Create the container, pulling the pinned image on the first-use "No such
   * image" 404. The pull reports aggregate download progress through `onProgress`
   * so the shell can show it in the "Starting preview…" overview.
   */
  private async createContainer(
    courseRoot: string,
    onProgress?: (progress: PreviewStartupProgress) => void,
  ): Promise<Docker.Container> {
    const options = buildPreviewContainerCreateOptions({
      image: this.image,
      courseRoot,
      courseId: previewCourseId(courseRoot),
      workspaces: await this.prepareWorkspaceSupport(courseRoot),
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
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event) => {
          const pullEvent = event as DockerPullEvent;
          // Keep the detailed per-layer line in the Output channel for diagnostics…
          const status = formatPullStatus(pullEvent);
          if (status) {
            this.log(`[pl-preview] ${status}`);
          }
          // …while the panel shows one aggregate download number.
          const { percent, layersDone, layersTotal } = aggregate.add(pullEvent);
          onProgress?.({ phase: 'pullingImage', percent, layersDone, layersTotal });
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
   * writable home root exist, then return the container-spec config. Returns
   * undefined when workspace support is disabled for this session.
   */
  private async prepareWorkspaceSupport(
    courseRoot: string,
  ): Promise<PreviewWorkspaceContainerConfig | undefined> {
    const support = this.workspaces;
    if (support == null) {
      return undefined;
    }

    const network = previewNetworkName(previewCourseId(courseRoot));
    const homeDir = workspaceHomeDir(support.homeRoot, courseRoot);
    await this.ensureNetwork(network);
    await fs.mkdir(homeDir, { recursive: true });
    // The container runs as uid 1001, which rarely matches the host user, so
    // make the bind-mounted home root writable regardless of ownership.
    await fs.chmod(homeDir, 0o777);

    return {
      dockerSocketPath: support.dockerSocketPath,
      network,
      homeDir,
      socketGid: support.socketGid,
    };
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
   * Reap any workspace containers this course's preview server left behind and
   * remove its now-unused network. The preview server reaps its own children on
   * a graceful stop; this is the backstop for a hard kill.
   */
  private async cleanupWorkspaceSupport(courseRoot: string): Promise<void> {
    const support = this.workspaces;
    if (support == null) {
      return;
    }
    await this.reapWorkspaceContainers(workspaceHomeDir(support.homeRoot, courseRoot));
    await this.removeNetwork(previewNetworkName(previewCourseId(courseRoot)));
  }

  private async reapWorkspaceContainers(homeDir: string): Promise<void> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${PREVIEW_WORKSPACE_CONTAINER_LABEL}=true`] },
      });
      await Promise.all(
        containers
          .filter((info) => info.Labels?.[PREVIEW_WORKSPACE_HOME_ROOT_LABEL] === homeDir)
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

/** Per-course host directory holding workspace home dirs; bind-mounted at the identical path. */
function workspaceHomeDir(homeRoot: string, courseRoot: string): string {
  return path.join(homeRoot, previewCourseId(courseRoot));
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
