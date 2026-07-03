import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PREVIEW_IMAGE,
  PREVIEW_CONTAINER_PORT,
  PREVIEW_COURSE_LABEL,
  PREVIEW_LABEL,
  PREVIEW_SERVER_ENTRYPOINT,
  buildPreviewContainerCreateOptions,
  resolvePreviewImage,
  resolvePublishedPort,
} from '../src/containerSpec';

const courseRoot = '/Users/author/my-course';

function createOptions() {
  return buildPreviewContainerCreateOptions({
    image: DEFAULT_PREVIEW_IMAGE,
    courseRoot,
    courseId: 'my-course',
  });
}

describe('buildPreviewContainerCreateOptions', () => {
  it('boots the standalone preview server with the mandatory plain-container flags', () => {
    const cmd = createOptions().Cmd ?? [];

    // Both flags are mandatory in a plain container: the defaults (loopback
    // bind, docker-in-docker "container" execution) silently break.
    assert.deepEqual(createOptions().Entrypoint, ['node', PREVIEW_SERVER_ENTRYPOINT]);
    assert.ok(adjacent(cmd, '--host', '0.0.0.0'), 'must pass --host 0.0.0.0');
    assert.ok(
      adjacent(cmd, '--workers-execution-mode', 'native'),
      'must pass --workers-execution-mode native',
    );
    assert.ok(adjacent(cmd, '--course-dir', '/course'), 'must serve the mounted course dir');
    assert.ok(
      adjacent(cmd, '--port', String(PREVIEW_CONTAINER_PORT)),
      'must listen on the exposed container port',
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

describe('resolvePreviewImage', () => {
  it('defaults to a pinned reference, never :latest', () => {
    assert.equal(resolvePreviewImage({}), DEFAULT_PREVIEW_IMAGE);
    assert.doesNotMatch(DEFAULT_PREVIEW_IMAGE, /:latest$/);
    assert.match(DEFAULT_PREVIEW_IMAGE, /:/, 'the reference must carry an explicit tag or digest');
  });

  it('honours a local PL_PREVIEW_IMAGE override for development', () => {
    assert.equal(
      resolvePreviewImage({ PL_PREVIEW_IMAGE: 'my/local-pl:dev' }),
      'my/local-pl:dev',
    );
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
