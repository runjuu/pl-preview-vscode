import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import Docker from 'dockerode';

import {
  buildPreviewContainerCreateOptions,
  type PreviewContainerInspect,
  resolvePreviewImage,
  resolvePublishedPort,
} from './containerSpec';
import {
  type DockerAvailability,
  type DockerPullEvent,
  PullProgressAggregator,
  classifyDockerProbe,
  formatPullStatus,
} from './dockerDetection';
import { previewOrigin } from './previewUrl';
import type { PreviewStartupProgress } from './startupProgress';

/**
 * Thin dockerode adapter: launches and tears down Local Preview Containers.
 *
 * This is the imperative shell around the pure `containerSpec` contract — it
 * owns the real Docker I/O (create/start/pull/inspect/logs/remove) and readiness
 * polling, and is deliberately *not* unit-tested (verified by driving the
 * extension). It keys containers by course root and exposes `ensureRunning` /
 * `stop` / `stopAll`; the warm-pool *policy* (LRU cap, idle reaping, dispose-all)
 * lives in the `PreviewController`, which drives these ports.
 */

/** How the extension observes and controls preview containers. */
export interface PreviewRuntime {
  /**
   * Report whether the Docker daemon is reachable, so the shell can guide a
   * first-run author (install/start Docker) instead of proceeding into a cryptic
   * socket error.
   */
  checkAvailability(): Promise<DockerAvailability>;
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
  /** Sink for container stdout/stderr and lifecycle notes (Output channel in prod). */
  log?: (line: string) => void;
}

const READINESS_ATTEMPTS = 120;
const READINESS_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1_000;

interface RunningContainer {
  container: Docker.Container;
  port: number;
}

export class DockerPreviewRuntime implements PreviewRuntime {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly log: (line: string) => void;
  private readonly running = new Map<string, RunningContainer>();

  constructor(options: DockerPreviewRuntimeOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.image = options.image ?? resolvePreviewImage();
    this.log = options.log ?? (() => {});
  }

  /**
   * Ping the Docker daemon and classify the outcome. When the ping fails we add a
   * best-effort "is the `docker` CLI on PATH" signal so a stopped Docker Desktop
   * (CLI present, socket gone) is reported as "not running" rather than "not
   * installed". The classification decision itself is the pure
   * {@link classifyDockerProbe}.
   */
  async checkAvailability(): Promise<DockerAvailability> {
    try {
      await this.docker.ping();
      return { kind: 'available' };
    } catch (pingError) {
      return classifyDockerProbe({ pingError, cliDetected: detectDockerCli() });
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
    await this.forceRemove(running.container);
  }

  async stopAll(): Promise<void> {
    const containers = [...this.running.values()];
    this.running.clear();
    await Promise.all(containers.map(({ container }) => this.forceRemove(container)));
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

/**
 * Best-effort check for a `docker` executable on PATH — a signal that Docker is
 * installed (so an unreachable daemon means "not running", not "not installed").
 * Scans PATH rather than spawning so it stays cheap and side-effect-free.
 */
function detectDockerCli(): boolean {
  const names = process.platform === 'win32' ? ['docker.exe', 'docker.com', 'docker'] : ['docker'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch {
        /* unreadable PATH entry; keep scanning */
      }
    }
  }
  return false;
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
