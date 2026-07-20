import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PREVIEW_IMAGE,
  PREVIEW_CONTAINER_PORT,
  PREVIEW_COURSE_LABEL,
  PREVIEW_DOCKER_SOCKET_MOUNT,
  PREVIEW_LABEL,
  PREVIEW_SERVER_ENTRYPOINT,
  PREVIEW_WORKSPACE_HOME_MOUNT,
  type PreviewImageInfo,
  buildPreviewContainerCreateOptions,
  formatBytes,
  parseImageReference,
  resolvePreviewImage,
  resolvePublishedPort,
  selectRemovablePreviewImages,
} from '../src/containerSpec';

const courseRoot = '/Users/author/my-course';
const authToken = 'extension-control-secret';
const PINNED_PREVIEW_IMAGE =
  'ghcr.io/runjuu/prairielearn:sha-6fd23e1@sha256:d480645624195991e42197f9105ae1a818065ca58098da041a2a6403fde3862a';

function createOptions() {
  return buildPreviewContainerCreateOptions({
    image: DEFAULT_PREVIEW_IMAGE,
    courseRoot,
    courseId: 'my-course',
    authToken,
  });
}

describe('buildPreviewContainerCreateOptions', () => {
  it('boots the experimental-1 server in explicit full mode without removed flags', () => {
    const cmd = createOptions().Cmd ?? [];

    // Both flags are mandatory in a plain container: the defaults (loopback
    // bind, docker-in-docker "container" execution) silently break.
    assert.deepEqual(createOptions().Entrypoint, ['node', PREVIEW_SERVER_ENTRYPOINT]);
    assert.ok(adjacent(cmd, '--host', '0.0.0.0'), 'must pass --host 0.0.0.0');
    assert.ok(adjacent(cmd, '--workers-execution-mode', 'native'), 'must pass --workers-execution-mode native');
    assert.ok(!cmd.includes('--course-dir'), 'the extension creates its Local Preview Session at runtime');
    assert.ok(adjacent(cmd, '--render-mode', 'full'), 'Preview Answer Check requires explicit full mode');
    assert.ok(adjacent(cmd, '--port', String(PREVIEW_CONTAINER_PORT)), 'must listen on the exposed container port');
    assert.ok(!cmd.includes('--no-workspaces'), 'the removed inverse workspace flag is never used');
    assert.ok(!cmd.includes('--workspaces'), 'workspaces stay at the disabled server default');
    assert.ok(
      createOptions().Env?.includes(`PRAIRIELEARN_PREVIEW_AUTH_TOKEN=${authToken}`),
      'the optional control plane is authenticated with a backend-only environment secret',
    );
  });

  it('bind-mounts the course read-only at the container course path', () => {
    const binds = createOptions().HostConfig?.Binds ?? [];

    assert.deepEqual(binds, [`${courseRoot}:/course:ro`]);
  });

  it('publishes the container port on a dynamic loopback host port', () => {
    const bindings = createOptions().HostConfig?.PortBindings ?? {};
    const published = bindings[`${PREVIEW_CONTAINER_PORT}/tcp`];

    assert.ok(published, 'the container port must be published');
    assert.equal(published[0].HostIp, '127.0.0.1', 'only loopback is reachable');
    // Empty HostPort tells Docker to pick a free ephemeral port — no hardcoded
    // 4310 on the host that would collide with a second course or a real PL.
    assert.equal(published[0].HostPort, '', 'the host port must be chosen dynamically');
    assert.ok(createOptions().ExposedPorts?.[`${PREVIEW_CONTAINER_PORT}/tcp`]);
  });

  it('renders untrusted question code under a hardened container', () => {
    const host = createOptions().HostConfig ?? {};

    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.equal(host.ReadonlyRootfs, true);
    assert.ok((host.SecurityOpt ?? []).includes('no-new-privileges:true'));
    assert.ok(host.Tmpfs?.['/tmp'], 'read-only rootfs needs a scratch /tmp');
    assert.equal(host.AutoRemove, true, 'stateless previews are cleaned up on stop');
    assert.ok((host.Memory ?? 0) > 0, 'memory ceiling is mandatory');
    assert.ok((host.NanoCpus ?? 0) > 0, 'cpu ceiling is mandatory');
    assert.ok((host.PidsLimit ?? 0) > 0, 'pid ceiling is mandatory');
    assert.notEqual(createOptions().User, 'root');
    assert.notEqual(createOptions().User, undefined);
  });

  it('does not attach the local container to any restricted network', () => {
    // The local extension renders the author's own trusted course, so it is not
    // put on a no-egress network.
    assert.equal(createOptions().HostConfig?.NetworkMode, undefined);
  });

  it('labels the container so it can be discovered and reconciled by course', () => {
    const labels = createOptions().Labels ?? {};

    assert.equal(PREVIEW_LABEL, 'pl-preview-vscode.preview');
    assert.equal(PREVIEW_COURSE_LABEL, 'pl-preview-vscode.preview.course');
    assert.equal(labels[PREVIEW_LABEL], 'true');
    assert.equal(labels[PREVIEW_COURSE_LABEL], 'my-course');
  });

  it('runs the caller-supplied image verbatim', () => {
    assert.equal(createOptions().Image, DEFAULT_PREVIEW_IMAGE);
  });
});

describe('buildPreviewContainerCreateOptions with workspace support', () => {
  const workspaces = {
    dockerSocketPath: '/Users/author/.docker/run/docker.sock',
    network: 'pl-preview-net-my-course',
    homeVolume: 'pl-preview-workspaces-my-course',
    socketGid: 20,
  };

  function workspaceOptions() {
    return buildPreviewContainerCreateOptions({
      image: DEFAULT_PREVIEW_IMAGE,
      courseRoot,
      courseId: 'my-course',
      authToken,
      workspaces,
    });
  }

  it('mounts the runtime socket and the named workspace-home volume', () => {
    const binds = workspaceOptions().HostConfig?.Binds ?? [];

    assert.ok(binds.includes(`${courseRoot}:/course:ro`), 'course stays read-only');
    assert.ok(
      binds.includes(`${workspaces.dockerSocketPath}:${PREVIEW_DOCKER_SOCKET_MOUNT}`),
      'the host runtime socket must be mounted where the ambient client expects it',
    );
    assert.equal(PREVIEW_WORKSPACE_HOME_MOUNT, '/pl-workspaces');
    assert.ok(
      binds.includes(`${workspaces.homeVolume}:${PREVIEW_WORKSPACE_HOME_MOUNT}`),
      'the named volume must be mounted at the fixed workspace-home mount point',
    );
  });

  it('joins the shared network and grants the socket group', () => {
    const host = workspaceOptions().HostConfig ?? {};

    assert.equal(host.NetworkMode, workspaces.network);
    assert.deepEqual(host.GroupAdd, ['20']);
  });

  it('passes the fixed home mount, the named volume, and the network to an explicitly workspace-enabled server', () => {
    const cmd = workspaceOptions().Cmd ?? [];

    assert.ok(
      adjacent(cmd, '--workspace-home-dir', PREVIEW_WORKSPACE_HOME_MOUNT),
      'the server writes homes at the fixed in-container mount, not a host path',
    );
    assert.ok(
      adjacent(cmd, '--workspace-home-volume', workspaces.homeVolume),
      'the server needs the named volume so sibling containers mount its subpaths',
    );
    assert.ok(adjacent(cmd, '--workspace-network', workspaces.network));
    assert.ok(cmd.includes('--workspaces'), 'Preview Workspaces are enabled explicitly');
    assert.ok(!cmd.includes('--no-workspaces'));
  });

  it('keeps the container hardened even with runtime access', () => {
    const host = workspaceOptions().HostConfig ?? {};

    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.AutoRemove, true);
    assert.notEqual(workspaceOptions().User, 'root');
  });

  it('omits the socket group when no gid is supplied', () => {
    const host =
      buildPreviewContainerCreateOptions({
        image: DEFAULT_PREVIEW_IMAGE,
        courseRoot,
        courseId: 'my-course',
        authToken,
        workspaces: { ...workspaces, socketGid: undefined },
      }).HostConfig ?? {};

    assert.equal(host.GroupAdd, undefined);
  });

  it('grants group 0 for a Docker Desktop root:root socket (gid 0 is not "no gid")', () => {
    const host =
      buildPreviewContainerCreateOptions({
        image: DEFAULT_PREVIEW_IMAGE,
        courseRoot,
        courseId: 'my-course',
        authToken,
        workspaces: { ...workspaces, socketGid: 0 },
      }).HostConfig ?? {};

    assert.deepEqual(host.GroupAdd, ['0']);
  });
});

describe('resolvePreviewImage', () => {
  it('defaults to a pinned reference, never :latest', () => {
    assert.equal(resolvePreviewImage({}), DEFAULT_PREVIEW_IMAGE);
    assert.equal(DEFAULT_PREVIEW_IMAGE, PINNED_PREVIEW_IMAGE);
    assert.doesNotMatch(DEFAULT_PREVIEW_IMAGE, /:latest$/);
    assert.match(DEFAULT_PREVIEW_IMAGE, /:/, 'the reference must carry an explicit tag or digest');
  });

  it('honours a local PL_PREVIEW_IMAGE override for development', () => {
    assert.equal(resolvePreviewImage({ PL_PREVIEW_IMAGE: 'my/local-pl:dev' }), 'my/local-pl:dev');
  });

  it('ignores a blank override', () => {
    assert.equal(resolvePreviewImage({ PL_PREVIEW_IMAGE: '   ' }), DEFAULT_PREVIEW_IMAGE);
  });
});

describe('resolvePublishedPort', () => {
  it('reads the published loopback host port from inspect data', () => {
    const port = resolvePublishedPort({
      Id: 'abc',
      NetworkSettings: {
        Ports: {
          [`${PREVIEW_CONTAINER_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '49812' }],
        },
      },
    });

    assert.equal(port, 49812);
  });

  it('throws when the container has no published binding yet', () => {
    assert.throws(() => resolvePublishedPort({ Id: 'abc', NetworkSettings: { Ports: {} } }));
  });
});

/** True when `value` appears in `list` immediately followed by `next`. */
function adjacent(list: string[], value: string, next: string): boolean {
  const index = list.indexOf(value);
  return index >= 0 && list[index + 1] === next;
}

describe('parseImageReference', () => {
  it('splits repo, tag, and digest from a fully-pinned reference', () => {
    const parsed = parseImageReference('ghcr.io/runjuu/prairielearn:sha-1c3e05a@sha256:abc');
    assert.equal(parsed.repo, 'ghcr.io/runjuu/prairielearn');
    assert.equal(parsed.tag, 'sha-1c3e05a');
    assert.equal(parsed.digest, 'sha256:abc');
  });

  it('reads a digest-only reference (no tag)', () => {
    const parsed = parseImageReference('ghcr.io/runjuu/prairielearn@sha256:abc');
    assert.equal(parsed.repo, 'ghcr.io/runjuu/prairielearn');
    assert.equal(parsed.tag, undefined);
    assert.equal(parsed.digest, 'sha256:abc');
  });

  it('reads a tag-only reference (no digest)', () => {
    const parsed = parseImageReference('my/local-pl:dev');
    assert.equal(parsed.repo, 'my/local-pl');
    assert.equal(parsed.tag, 'dev');
    assert.equal(parsed.digest, undefined);
  });

  it('does not mistake a registry port for a tag', () => {
    const withTag = parseImageReference('localhost:5000/pl:dev');
    assert.equal(withTag.repo, 'localhost:5000/pl');
    assert.equal(withTag.tag, 'dev');

    const bare = parseImageReference('localhost:5000/pl');
    assert.equal(bare.repo, 'localhost:5000/pl');
    assert.equal(bare.tag, undefined);
  });
});

describe('selectRemovablePreviewImages', () => {
  const current = parseImageReference(DEFAULT_PREVIEW_IMAGE);
  const REPO = current.repo;

  const currentImage: PreviewImageInfo = {
    Id: 'sha256:current',
    RepoTags: [`${REPO}:${current.tag}`],
    RepoDigests: [`${REPO}@${current.digest}`],
    Size: 2_100_000_000,
  };
  const oldTagged: PreviewImageInfo = {
    Id: 'sha256:old1',
    RepoTags: [`${REPO}:sha-0af9b21`],
    RepoDigests: [`${REPO}@sha256:0af9`],
    Size: 2_050_000_000,
  };
  const oldDigestOnly: PreviewImageInfo = {
    Id: 'sha256:old2',
    RepoTags: ['<none>:<none>'],
    RepoDigests: [`${REPO}@sha256:1111abcdef2222deadbeef`],
    Size: 2_000_000_000,
  };
  const unrelated: PreviewImageInfo = {
    Id: 'sha256:node',
    RepoTags: ['node:20'],
    RepoDigests: ['node@sha256:cafe'],
    Size: 900_000_000,
  };

  it('keeps the current image and ignores every unrelated repo', () => {
    const removable = selectRemovablePreviewImages([currentImage, unrelated], DEFAULT_PREVIEW_IMAGE);
    assert.deepEqual(removable, []);
  });

  it('selects old preview images of the same repo, labelled by tag or short digest', () => {
    const removable = selectRemovablePreviewImages(
      [currentImage, oldTagged, oldDigestOnly, unrelated],
      DEFAULT_PREVIEW_IMAGE,
    );

    assert.deepEqual(
      removable.map((image) => image.id),
      ['sha256:old1', 'sha256:old2'],
    );
    assert.equal(removable[0].name, 'sha-0af9b21', 'prefers the git-sha tag');
    assert.equal(removable[1].name, '1111abcdef22', 'falls back to the short repo digest');
    assert.equal(removable[0].size, 2_050_000_000);
  });

  it('excludes the current image when matched only by digest (its tag moved away)', () => {
    const digestOnlyCurrent: PreviewImageInfo = {
      Id: 'sha256:current',
      RepoTags: null,
      RepoDigests: [`${REPO}@${current.digest}`],
      Size: 2_100_000_000,
    };
    const removable = selectRemovablePreviewImages([digestOnlyCurrent, oldTagged], DEFAULT_PREVIEW_IMAGE);
    assert.deepEqual(
      removable.map((image) => image.id),
      ['sha256:old1'],
    );
  });

  it('excludes the current image even when it carries extra tags', () => {
    const multiTagged: PreviewImageInfo = {
      Id: 'sha256:current',
      RepoTags: [`${REPO}:${current.tag}`, `${REPO}:latest`],
      RepoDigests: [`${REPO}@${current.digest}`],
      Size: 2_100_000_000,
    };
    assert.deepEqual(selectRemovablePreviewImages([multiTagged], DEFAULT_PREVIEW_IMAGE), []);
  });

  it('honours a PL_PREVIEW_IMAGE override pointing at another repo', () => {
    const localCurrent: PreviewImageInfo = {
      Id: 'sha256:localcur',
      RepoTags: ['my/local-pl:dev'],
      RepoDigests: [],
      Size: 1_000,
    };
    const localOld: PreviewImageInfo = {
      Id: 'sha256:localold',
      RepoTags: ['my/local-pl:old'],
      RepoDigests: [],
      Size: 2_000,
    };
    const removable = selectRemovablePreviewImages(
      [localCurrent, localOld, currentImage, oldTagged],
      'my/local-pl:dev',
    );
    // Only the override repo is touched; the ghcr images are ignored entirely.
    assert.deepEqual(
      removable.map((image) => image.id),
      ['sha256:localold'],
    );
  });
});

describe('formatBytes', () => {
  it('scales bytes into B/KB/MB/GB, one decimal above bytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1 MB');
    assert.equal(formatBytes(2.1 * 1024 * 1024 * 1024), '2.1 GB');
  });

  it('treats a non-positive or non-finite size as zero', () => {
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });
});
