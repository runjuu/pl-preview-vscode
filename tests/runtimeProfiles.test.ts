import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOCKER_PROFILE,
  type EndpointContext,
  PODMAN_PROFILE,
  candidateEndpoints,
  dockerodeOptionsForEndpoint,
  parseContainerHost,
} from '../src/runtimeProfiles';

function ctx(over: Partial<EndpointContext> = {}): EndpointContext {
  return { env: {}, platform: 'linux', home: '/home/u', ...over };
}

describe('parseContainerHost', () => {
  it('parses a unix socket path', () => {
    assert.deepEqual(parseContainerHost('unix:///run/user/1000/podman/podman.sock'), {
      kind: 'socket',
      socketPath: '/run/user/1000/podman/podman.sock',
    });
  });

  it('parses a Windows named pipe, defaulting the bare form to the Docker pipe', () => {
    assert.deepEqual(parseContainerHost('npipe:////./pipe/podman-machine-default'), {
      kind: 'socket',
      socketPath: '//./pipe/podman-machine-default',
    });
    assert.deepEqual(parseContainerHost('npipe://'), {
      kind: 'socket',
      socketPath: '//./pipe/docker_engine',
    });
  });

  it('parses a tcp endpoint, and a bare host:port as tcp', () => {
    assert.deepEqual(parseContainerHost('tcp://127.0.0.1:2375'), {
      kind: 'tcp',
      host: '127.0.0.1',
      port: 2375,
      protocol: 'http',
    });
    assert.deepEqual(parseContainerHost('127.0.0.1:2375'), {
      kind: 'tcp',
      host: '127.0.0.1',
      port: 2375,
      protocol: 'http',
    });
  });

  it('accepts a bare absolute socket path (as podman machine inspect / docker context emit)', () => {
    assert.deepEqual(parseContainerHost('/var/folders/xy/podman-machine-default-api.sock'), {
      kind: 'socket',
      socketPath: '/var/folders/xy/podman-machine-default-api.sock',
    });
    assert.deepEqual(parseContainerHost('\\\\.\\pipe\\podman-machine-default'), {
      kind: 'socket',
      socketPath: '\\\\.\\pipe\\podman-machine-default',
    });
  });

  it('parses an https endpoint and defaults its port', () => {
    assert.deepEqual(parseContainerHost('https://10.0.0.1'), {
      kind: 'tcp',
      host: '10.0.0.1',
      port: 2376,
      protocol: 'https',
    });
  });

  it('parses an ssh endpoint with an optional username and default port', () => {
    assert.deepEqual(parseContainerHost('ssh://core@vm.local:2222'), {
      kind: 'ssh',
      host: 'vm.local',
      port: 2222,
      username: 'core',
    });
    assert.deepEqual(parseContainerHost('ssh://vm.local'), {
      kind: 'ssh',
      host: 'vm.local',
      port: 22,
      username: undefined,
    });
  });

  it('returns undefined for blank, missing, or unparseable values', () => {
    assert.equal(parseContainerHost(undefined), undefined);
    assert.equal(parseContainerHost(''), undefined);
    assert.equal(parseContainerHost('   '), undefined);
    assert.equal(parseContainerHost('unix://'), undefined); // no socket path
    assert.equal(parseContainerHost('tcp://has a space'), undefined);
  });
});

describe('dockerodeOptionsForEndpoint', () => {
  it('maps a socket endpoint and neutralizes the network fields', () => {
    const opts = dockerodeOptionsForEndpoint({ kind: 'socket', socketPath: '/x.sock' });
    assert.equal(opts.socketPath, '/x.sock');
    assert.equal(opts.host, undefined);
    assert.equal(opts.port, undefined);
    assert.equal(opts.protocol, undefined);
  });

  it('maps a tcp endpoint and neutralizes the socket path', () => {
    const opts = dockerodeOptionsForEndpoint({ kind: 'tcp', host: 'h', port: 2375, protocol: 'http' });
    assert.equal(opts.socketPath, undefined);
    assert.equal(opts.host, 'h');
    assert.equal(opts.port, 2375);
    assert.equal(opts.protocol, 'http');
  });

  it('maps an ssh endpoint with the ssh protocol', () => {
    const opts = dockerodeOptionsForEndpoint({ kind: 'ssh', host: 'h', port: 22, username: 'core' });
    assert.equal(opts.socketPath, undefined);
    assert.equal(opts.host, 'h');
    assert.equal(opts.port, 22);
    assert.equal(opts.protocol, 'ssh');
    assert.equal(opts.username, 'core');
  });
});

describe('DOCKER_PROFILE', () => {
  it('derives an endpoint from DOCKER_HOST', () => {
    assert.deepEqual(DOCKER_PROFILE.envEndpoint(ctx({ env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } })), {
      kind: 'socket',
      socketPath: '/var/run/docker.sock',
    });
    assert.equal(DOCKER_PROFILE.envEndpoint(ctx()), undefined);
  });

  it('probes the per-user then system socket on unix, and the named pipe on Windows', () => {
    assert.deepEqual(DOCKER_PROFILE.wellKnownEndpoints(ctx({ platform: 'linux', home: '/home/u' })), [
      { kind: 'socket', socketPath: '/home/u/.docker/run/docker.sock' },
      { kind: 'socket', socketPath: '/var/run/docker.sock' },
    ]);
    assert.deepEqual(DOCKER_PROFILE.wellKnownEndpoints(ctx({ platform: 'win32' })), [
      { kind: 'socket', socketPath: '//./pipe/docker_engine' },
    ]);
  });

  it('launches Docker Desktop per platform', () => {
    assert.deepEqual(DOCKER_PROFILE.startAction(ctx({ platform: 'darwin' })), {
      label: 'Start Docker Desktop',
      command: 'open',
      args: ['-a', 'Docker'],
      mode: 'launchApp',
    });
    assert.deepEqual(DOCKER_PROFILE.startAction(ctx({ platform: 'win32', programFiles: 'D:\\Programs' })), {
      label: 'Start Docker Desktop',
      command: 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe',
      args: [],
      mode: 'launchApp',
    });
    assert.equal(
      DOCKER_PROFILE.startAction(ctx({ platform: 'win32' }))?.command,
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    );
    // An empty %ProgramFiles% is treated as unset, not a bare "\\Docker" path.
    assert.equal(
      DOCKER_PROFILE.startAction(ctx({ platform: 'win32', programFiles: '' }))?.command.startsWith('C:\\Program Files'),
      true,
    );
    assert.equal(DOCKER_PROFILE.startAction(ctx({ platform: 'linux' })), undefined);
  });

  it('lists the env endpoint first, then the well-known sockets', () => {
    const candidates = candidateEndpoints(
      DOCKER_PROFILE,
      ctx({ env: { DOCKER_HOST: 'tcp://127.0.0.1:2375' }, platform: 'linux', home: '/home/u' }),
    );
    assert.deepEqual(candidates, [
      { kind: 'tcp', host: '127.0.0.1', port: 2375, protocol: 'http' },
      { kind: 'socket', socketPath: '/home/u/.docker/run/docker.sock' },
      { kind: 'socket', socketPath: '/var/run/docker.sock' },
    ]);
  });
});

describe('PODMAN_PROFILE', () => {
  it('prefers CONTAINER_HOST, falling back to DOCKER_HOST', () => {
    assert.deepEqual(
      PODMAN_PROFILE.envEndpoint(ctx({ env: { CONTAINER_HOST: 'unix:///run/podman.sock', DOCKER_HOST: 'unix:///d.sock' } })),
      { kind: 'socket', socketPath: '/run/podman.sock' },
    );
    assert.deepEqual(PODMAN_PROFILE.envEndpoint(ctx({ env: { DOCKER_HOST: 'unix:///d.sock' } })), {
      kind: 'socket',
      socketPath: '/d.sock',
    });
    assert.equal(PODMAN_PROFILE.envEndpoint(ctx()), undefined);
  });

  it('probes the rootless then rootful socket on Linux, and nothing on macOS/Windows', () => {
    assert.deepEqual(
      PODMAN_PROFILE.wellKnownEndpoints(ctx({ platform: 'linux', xdgRuntimeDir: '/run/user/1000' })),
      [
        { kind: 'socket', socketPath: '/run/user/1000/podman/podman.sock' },
        { kind: 'socket', socketPath: '/run/podman/podman.sock' },
      ],
    );
    assert.deepEqual(PODMAN_PROFILE.wellKnownEndpoints(ctx({ platform: 'linux' })), [
      { kind: 'socket', socketPath: '/run/podman/podman.sock' },
    ]);
    assert.deepEqual(PODMAN_PROFILE.wellKnownEndpoints(ctx({ platform: 'darwin' })), []);
    assert.deepEqual(PODMAN_PROFILE.wellKnownEndpoints(ctx({ platform: 'win32' })), []);
  });

  it('starts the machine on macOS/Windows and the user socket on Linux', () => {
    assert.deepEqual(PODMAN_PROFILE.startAction(ctx({ platform: 'darwin' })), {
      label: 'Start Podman machine',
      command: 'podman',
      args: ['machine', 'start'],
      mode: 'runToCompletion',
    });
    assert.deepEqual(PODMAN_PROFILE.startAction(ctx({ platform: 'win32' })), {
      label: 'Start Podman machine',
      command: 'podman',
      args: ['machine', 'start'],
      mode: 'runToCompletion',
    });
    assert.deepEqual(PODMAN_PROFILE.startAction(ctx({ platform: 'linux' })), {
      label: 'Start Podman',
      command: 'systemctl',
      args: ['--user', 'start', 'podman.socket'],
      mode: 'runToCompletion',
    });
  });
});
