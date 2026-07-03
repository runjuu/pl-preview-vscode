import type Docker from 'dockerode';

/**
 * Pure construction of the dockerode spec for a Local Preview Container and
 * resolution of its published loopback port. Kept free of dockerode/HTTP I/O so
 * the container contract (command flags, read-only mount, dynamic port, image
 * pin, hardening) is unit-testable without Docker. The imperative dockerode
 * adapter (`dockerRuntime.ts`) is the thin shell that consumes this.
 */

/**
 * Pinned preview-server image. Never `:latest`: the tag is tied to a known-good
 * build of the standalone preview server so an upstream image change is a
 * coordinated extension release rather than a silent drift. `resolvePreviewImage`
 * lets local development point at a self-built image.
 */
export const DEFAULT_PREVIEW_IMAGE = 'ghcr.io/runjuu/prairielearn:sha-be4b11c@sha256:a0fa1c91ab9a8b9d587c4c219351fd5959a76695011da366bd100982b86da46f';

/** Environment override used to point the extension at a locally-built image. */
export const PREVIEW_IMAGE_ENV_VAR = 'PL_PREVIEW_IMAGE';

/** Port the standalone preview server listens on inside the container. */
export const PREVIEW_CONTAINER_PORT = 4310;

/**
 * Path to the standalone preview-server entrypoint inside the image. The image
 * ships no ENTRYPOINT (its default `Cmd` boots full PrairieLearn), so we invoke
 * `node <this>` ourselves; bare flags would be exec'd as a binary.
 */
export const PREVIEW_SERVER_ENTRYPOINT =
  '/PrairieLearn/apps/prairielearn/dist/preview-server.js';

/** Path the course tree is bind-mounted at inside the container. */
export const PREVIEW_COURSE_MOUNT = '/course';

/**
 * Small writable tmpfs at `/tmp`; the rest of the rootfs is read-only. `noexec`
 * stops untrusted question code from staging and running a binary it writes and
 * `nosuid` neutralizes setuid bits — both safe for native rendering.
 */
export const PREVIEW_TMP_TMPFS = 'rw,nosuid,noexec,size=64m';

/** Marks a container as owned by this extension (for discovery/reconciliation). */
export const PREVIEW_LABEL = 'pl-preview-vscode.preview';
/** Records which course root a container serves. */
export const PREVIEW_COURSE_LABEL = 'pl-preview-vscode.preview.course';

/** Non-root uid:gid the container runs as. */
export const PREVIEW_CONTAINER_USER = '1001:1001';

/** Per-container resource ceilings for untrusted question code. */
export const DEFAULT_PREVIEW_MEMORY_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_PREVIEW_NANO_CPUS = 1_000_000_000;
export const DEFAULT_PREVIEW_PIDS_LIMIT = 256;

const PORT_KEY = `${PREVIEW_CONTAINER_PORT}/tcp`;

export interface PreviewContainerSpecInput {
  /** Pinned preview-server image reference. */
  image: string;
  /** Absolute host path of the course root; bind-mounted read-only. */
  courseRoot: string;
  /** Stable identifier for the course (used for the label and container name). */
  courseId: string;
}

/**
 * Resolve the preview-server image, honouring a `PL_PREVIEW_IMAGE` override so a
 * developer can render against a self-built image. A blank override is ignored,
 * so the pinned default is never accidentally cleared to an empty reference.
 */
export function resolvePreviewImage(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[PREVIEW_IMAGE_ENV_VAR]?.trim();
  return override ? override : DEFAULT_PREVIEW_IMAGE;
}

/**
 * Build the dockerode create options for a course's Local Preview Container.
 *
 * The container runs the author's `server.py` and custom elements, so it is
 * hardened (non-root, all caps dropped, no-new-privileges, read-only rootfs with
 * a small `/tmp` tmpfs, memory/CPU/PID ceilings). Unlike the hosted stack it is
 * *not* attached to a no-egress network because the local author's own course is
 * trusted. The course is bound read-only so a render can never mutate the
 * author's source, and the port is published on an ephemeral loopback host port
 * so a second course (or a real PrairieLearn) never collides on 4310.
 */
export function buildPreviewContainerCreateOptions(
  input: PreviewContainerSpecInput,
): Docker.ContainerCreateOptions {
  const { image, courseRoot, courseId } = input;

  const hostConfig: Docker.HostConfig = {
    Binds: [`${courseRoot}:${PREVIEW_COURSE_MOUNT}:ro`],
    // Dynamic loopback publish: Docker picks a free host port, reachable only
    // from 127.0.0.1.
    PortBindings: { [PORT_KEY]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
    Memory: DEFAULT_PREVIEW_MEMORY_BYTES,
    // Pin memory+swap to the ceiling so it is a hard cap (Docker otherwise
    // defaults swap to 2x memory).
    MemorySwap: DEFAULT_PREVIEW_MEMORY_BYTES,
    NanoCpus: DEFAULT_PREVIEW_NANO_CPUS,
    PidsLimit: DEFAULT_PREVIEW_PIDS_LIMIT,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': PREVIEW_TMP_TMPFS },
    // Previews are stateless and short-lived; let Docker reclaim them on stop.
    AutoRemove: true,
  };

  return {
    Image: image,
    User: PREVIEW_CONTAINER_USER,
    // Keep native Python from writing .pyc files onto the read-only rootfs.
    Env: ['PYTHONDONTWRITEBYTECODE=1'],
    Entrypoint: ['node', PREVIEW_SERVER_ENTRYPOINT],
    Cmd: [
      '--course-dir',
      PREVIEW_COURSE_MOUNT,
      '--host',
      '0.0.0.0',
      '--port',
      String(PREVIEW_CONTAINER_PORT),
      '--workers-execution-mode',
      'native',
    ],
    Labels: {
      [PREVIEW_LABEL]: 'true',
      [PREVIEW_COURSE_LABEL]: courseId,
    },
    ExposedPorts: { [PORT_KEY]: {} },
    HostConfig: hostConfig,
  };
}

/** The subset of a container inspect payload the preview code reads. */
export interface PreviewContainerInspect {
  readonly Id: string;
  readonly State?: { readonly Running?: boolean };
  readonly NetworkSettings?: {
    readonly Ports?: {
      readonly [portAndProtocol: string]:
        | ReadonlyArray<{ readonly HostIp: string; readonly HostPort: string }>
        | undefined;
    };
  };
}

/**
 * Resolve the ephemeral loopback host port Docker published for the container's
 * preview port. Throws while the container is still starting and has no binding.
 */
export function resolvePublishedPort(inspect: PreviewContainerInspect): number {
  const binding = inspect.NetworkSettings?.Ports?.[PORT_KEY]?.[0];
  const hostPort = binding?.HostPort;
  if (!hostPort) {
    throw new Error(`Preview container ${inspect.Id} has no published ${PORT_KEY} binding yet`);
  }
  return Number(hostPort);
}
