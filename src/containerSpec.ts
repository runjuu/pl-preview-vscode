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
export const DEFAULT_PREVIEW_IMAGE = 'ghcr.io/runjuu/prairielearn:sha-1c3e05a@sha256:fe84085f5db67736254aad825d181b508c992b1768794a1d439fd50f258264a8';

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
 * Path the host container-runtime socket is bind-mounted at inside the
 * container when workspace support is enabled. The in-container preview server
 * launches workspace containers through the ambient Docker client, which
 * defaults to this path, so mounting here needs no extra configuration.
 */
export const PREVIEW_DOCKER_SOCKET_MOUNT = '/var/run/docker.sock';

/** Labels the preview server applies to the workspace containers it launches. */
export const PREVIEW_WORKSPACE_CONTAINER_LABEL = 'com.prairielearn.preview-workspace';
export const PREVIEW_WORKSPACE_HOME_ROOT_LABEL = 'com.prairielearn.preview-workspace.home-root';

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

/**
 * Enables workspace-question support by granting the preview container access
 * to the host container runtime. Present only for a trusted workspace on a
 * socket-based runtime; absent otherwise (the container stays jailed and the
 * server runs with workspaces disabled).
 */
export interface PreviewWorkspaceContainerConfig {
  /** Host path of the runtime socket, bind-mounted so the server can launch containers. */
  dockerSocketPath: string;
  /** Shared user-defined network the preview and workspace containers join. */
  network: string;
  /**
   * Writable host directory that holds workspace home dirs. Bind-mounted at the
   * identical path so the sibling workspace containers (created on the host
   * daemon) can bind the same paths.
   */
  homeDir: string;
  /**
   * Supplementary group gid granting the non-root container user socket access:
   * the socket's real group on native Linux, or group 0 on VM-backed runtimes
   * (Docker Desktop et al.) that re-present the mounted socket as root:root.
   */
  socketGid?: number;
}

export interface PreviewContainerSpecInput {
  /** Pinned preview-server image reference. */
  image: string;
  /** Absolute host path of the course root; bind-mounted read-only. */
  courseRoot: string;
  /** Stable identifier for the course (used for the label and container name). */
  courseId: string;
  /**
   * When set, the preview server can launch workspace-question containers. This
   * widens the container's privilege (a mounted runtime socket is host-root
   * equivalent with a rootful daemon), so callers gate it on workspace trust.
   */
  workspaces?: PreviewWorkspaceContainerConfig;
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

/** The parts of a Docker image reference `registry/repo[:tag][@digest]`. */
export interface ParsedImageReference {
  /** Registry + repository path, e.g. `ghcr.io/runjuu/prairielearn`. */
  readonly repo: string;
  /** The `:tag`, if the reference carries one. */
  readonly tag?: string;
  /** The `@sha256:…` content digest, if the reference carries one. */
  readonly digest?: string;
}

/**
 * Split an image reference into repo / tag / digest. The tag colon lives only in
 * the last path segment, so a registry port (`host:5000/repo`) is not mistaken for
 * a tag; the digest is whatever follows `@`.
 */
export function parseImageReference(reference: string): ParsedImageReference {
  const at = reference.indexOf('@');
  const digest = at >= 0 ? reference.slice(at + 1) : undefined;
  const nameAndTag = at >= 0 ? reference.slice(0, at) : reference;

  const lastSlash = nameAndTag.lastIndexOf('/');
  const lastColon = nameAndTag.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return { repo: nameAndTag.slice(0, lastColon), tag: nameAndTag.slice(lastColon + 1), digest };
  }
  return { repo: nameAndTag, digest };
}

/**
 * The subset of a dockerode image-summary (`Docker.ImageInfo`) the preview cleanup
 * reads. Kept as a local shape so the selection logic stays free of dockerode and
 * unit-testable, mirroring {@link PreviewContainerInspect}.
 */
export interface PreviewImageInfo {
  readonly Id: string;
  readonly RepoTags?: readonly string[] | null;
  readonly RepoDigests?: readonly string[] | null;
  readonly Size: number;
  readonly Created?: number;
}

/** A superseded preview image the user can reclaim disk space by removing. */
export interface RemovablePreviewImage {
  /** Image id (`sha256:…`) to remove. */
  readonly id: string;
  /** Friendly label for the confirm prompt: the git-sha tag, else a short digest. */
  readonly name: string;
  /** On-disk size in bytes (dockerode's shared-layer-unaware `Size`). */
  readonly size: number;
  /** Unix seconds the image was created, when reported. */
  readonly created?: number;
}

/** Docker uses this placeholder for an untagged image's repo/tag/digest. */
const NONE_REF = '<none>';

/**
 * Select the preview images that are safe to delete: every image of the *current*
 * image's repository except the current one itself. The current image is matched by
 * its pinned digest **or** tag (dockerode groups all refs of one image under a single
 * `Id`, so an image carrying extra tags is still recognised as current and kept).
 * Images of any other repository (`node`, `postgres`, a `PL_PREVIEW_IMAGE` override
 * pointing elsewhere) are ignored — this only ever prunes the preview repo.
 */
export function selectRemovablePreviewImages(
  images: readonly PreviewImageInfo[],
  currentReference: string,
): RemovablePreviewImage[] {
  const current = parseImageReference(currentReference);
  const removable: RemovablePreviewImage[] = [];

  for (const image of images) {
    const tags = (image.RepoTags ?? []).filter((ref) => ref && !ref.startsWith(NONE_REF));
    const digests = (image.RepoDigests ?? []).filter((ref) => ref && !ref.startsWith(NONE_REF));

    // Only touch images of the current preview repository.
    const repoTags = tags.filter((ref) => parseImageReference(ref).repo === current.repo);
    const repoDigests = digests.filter((ref) => parseImageReference(ref).repo === current.repo);
    if (repoTags.length === 0 && repoDigests.length === 0) {
      continue;
    }

    // Never remove the image the extension is currently pinned to.
    const isCurrent =
      (current.digest != null && repoDigests.includes(`${current.repo}@${current.digest}`)) ||
      (current.tag != null && repoTags.includes(`${current.repo}:${current.tag}`));
    if (isCurrent) {
      continue;
    }

    removable.push({
      id: image.Id,
      name: friendlyImageName(repoTags, repoDigests, image.Id),
      size: image.Size,
      created: image.Created,
    });
  }

  return removable;
}

/** Prefer a git-sha tag, then a short repo digest, then the image id, for display. */
function friendlyImageName(
  repoTags: readonly string[],
  repoDigests: readonly string[],
  id: string,
): string {
  for (const ref of repoTags) {
    const { tag } = parseImageReference(ref);
    if (tag) return tag;
  }
  for (const ref of repoDigests) {
    const { digest } = parseImageReference(ref);
    if (digest) return shortDigest(digest);
  }
  return shortDigest(id);
}

/** `sha256:fe84085f5db6…` → `fe84085f5db6` (first 12 hex chars). */
function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

/** Render a byte count as a compact `2.1 GB` / `512 MB` / `0 B` label. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes stay whole; larger units carry one decimal (dropping a trailing `.0`).
  const rounded = unit === 0 ? value : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
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
  const { image, courseRoot, courseId, workspaces } = input;

  const binds = [`${courseRoot}:${PREVIEW_COURSE_MOUNT}:ro`];
  const cmd = [
    '--course-dir',
    PREVIEW_COURSE_MOUNT,
    '--host',
    '0.0.0.0',
    '--port',
    String(PREVIEW_CONTAINER_PORT),
    '--workers-execution-mode',
    'native',
  ];

  const hostConfig: Docker.HostConfig = {
    Binds: binds,
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

  if (workspaces == null) {
    // No runtime access: disable the workspace manager so workspace questions
    // render a clear "disabled" page instead of failing to launch a container.
    cmd.push('--no-workspaces');
  } else {
    // Mount the host runtime socket so the server can launch workspace
    // containers as siblings, join them on a shared network so it can reach
    // them by alias, and expose a writable, identically-pathed home root it can
    // populate for them (sibling containers bind the same host paths).
    binds.push(`${workspaces.dockerSocketPath}:${PREVIEW_DOCKER_SOCKET_MOUNT}`);
    binds.push(`${workspaces.homeDir}:${workspaces.homeDir}`);
    hostConfig.NetworkMode = workspaces.network;
    if (workspaces.socketGid != null) {
      // The non-root container user needs the socket's group to open it.
      hostConfig.GroupAdd = [String(workspaces.socketGid)];
    }
    cmd.push(
      '--workspace-home-dir',
      workspaces.homeDir,
      '--workspace-network',
      workspaces.network,
    );
  }

  return {
    Image: image,
    User: PREVIEW_CONTAINER_USER,
    // Keep native Python from writing .pyc files onto the read-only rootfs.
    Env: ['PYTHONDONTWRITEBYTECODE=1'],
    Entrypoint: ['node', PREVIEW_SERVER_ENTRYPOINT],
    Cmd: cmd,
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
