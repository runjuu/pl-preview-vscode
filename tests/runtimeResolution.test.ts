import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RuntimeAvailability } from '../src/runtimeDetection';
import type { EndpointContext, RuntimeEndpoint } from '../src/runtimeProfiles';
import {
  type RuntimeCandidate,
  type RuntimeConfig,
  resolveRuntimeSelection,
  runtimeCandidates,
} from '../src/runtimeResolution';

function ctx(over: Partial<EndpointContext> = {}): EndpointContext {
  return { env: {}, platform: 'linux', home: '/home/u', xdgRuntimeDir: '/run/user/1000', ...over };
}

function config(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { runtime: 'auto', containerHost: '', ...over };
}

/** A stable key for an endpoint, so a fake probe can be keyed by it. */
function key(endpoint: RuntimeEndpoint): string {
  switch (endpoint.kind) {
    case 'socket':
      return `socket:${endpoint.socketPath}`;
    case 'tcp':
      return `tcp:${endpoint.host}:${endpoint.port}`;
    case 'ssh':
      return `ssh:${endpoint.host}:${endpoint.port}`;
  }
}

/** A fake probe: endpoints in `up` are available, everything else `notInstalled`. */
function probeWith(reachable: Record<string, RuntimeAvailability>) {
  return async (candidate: RuntimeCandidate): Promise<RuntimeAvailability> =>
    reachable[key(candidate.endpoint)] ?? { kind: 'notInstalled' };
}

function candidatesOf(resolved: ReturnType<typeof runtimeCandidates>): readonly RuntimeCandidate[] {
  assert.equal(resolved.kind, 'candidates');
  return resolved.kind === 'candidates' ? resolved.candidates : [];
}

describe('runtimeCandidates', () => {
  it('errors when custom is selected without a host or env', () => {
    const resolved = runtimeCandidates(config({ runtime: 'custom' }), ctx());
    assert.equal(resolved.kind, 'configError');
  });

  it('uses the containerHost setting for custom (tagged as a setting)', () => {
    const resolved = runtimeCandidates(
      config({ runtime: 'custom', containerHost: 'unix:///run/podman.sock' }),
      ctx(),
    );
    const candidates = candidatesOf(resolved);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].profile.id, 'custom');
    assert.equal(candidates[0].source, 'setting');
    assert.deepEqual(candidates[0].endpoint, { kind: 'socket', socketPath: '/run/podman.sock' });
  });

  it('falls back to DOCKER_HOST for custom when no setting is given (tagged as env)', () => {
    const resolved = runtimeCandidates(
      config({ runtime: 'custom' }),
      ctx({ env: { DOCKER_HOST: 'tcp://127.0.0.1:2375' } }),
    );
    const candidates = candidatesOf(resolved);
    assert.equal(candidates[0].source, 'env');
    assert.deepEqual(candidates[0].endpoint, { kind: 'tcp', host: '127.0.0.1', port: 2375, protocol: 'http' });
  });

  it('errors on an unparseable custom endpoint', () => {
    const resolved = runtimeCandidates(config({ runtime: 'custom', containerHost: 'nonsense with spaces' }), ctx());
    assert.equal(resolved.kind, 'configError');
  });

  it('resolves docker to its env then well-known sockets', () => {
    const candidates = candidatesOf(runtimeCandidates(config({ runtime: 'docker' }), ctx({ home: '/home/u' })));
    assert.deepEqual(
      candidates.map((c) => c.endpoint),
      [
        { kind: 'socket', socketPath: '/home/u/.docker/run/docker.sock' },
        { kind: 'socket', socketPath: '/var/run/docker.sock' },
      ],
    );
    assert.ok(candidates.every((c) => c.profile.id === 'docker'));
  });

  it('errors when podman is selected but no socket can be located (macOS, no env)', () => {
    const resolved = runtimeCandidates(config({ runtime: 'podman' }), ctx({ platform: 'darwin' }));
    assert.equal(resolved.kind, 'configError');
  });

  it('auto lets an explicit containerHost override detection', () => {
    const candidates = candidatesOf(
      runtimeCandidates(config({ runtime: 'auto', containerHost: 'unix:///x.sock' }), ctx()),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].profile.id, 'custom');
  });

  it('auto orders Docker candidates before Podman candidates', () => {
    const candidates = candidatesOf(runtimeCandidates(config({ runtime: 'auto' }), ctx({ home: '/home/u' })));
    assert.deepEqual(
      candidates.map((c) => [c.profile.id, key(c.endpoint)]),
      [
        ['docker', 'socket:/home/u/.docker/run/docker.sock'],
        ['docker', 'socket:/var/run/docker.sock'],
        ['podman', 'socket:/run/user/1000/podman/podman.sock'],
        ['podman', 'socket:/run/podman/podman.sock'],
      ],
    );
  });

  it('auto surfaces DOCKER_HOST (docker) and CONTAINER_HOST (podman) as env candidates', () => {
    const candidates = candidatesOf(
      runtimeCandidates(
        config({ runtime: 'auto' }),
        ctx({ env: { DOCKER_HOST: 'tcp://d:2375', CONTAINER_HOST: 'unix:///p.sock' }, home: '/home/u' }),
      ),
    );
    const docker = candidates.filter((c) => c.profile.id === 'docker');
    const podman = candidates.filter((c) => c.profile.id === 'podman');
    assert.equal(docker[0].source, 'env');
    assert.deepEqual(docker[0].endpoint, { kind: 'tcp', host: 'd', port: 2375, protocol: 'http' });
    assert.equal(podman[0].source, 'env');
    assert.deepEqual(podman[0].endpoint, { kind: 'socket', socketPath: '/p.sock' });
  });
});

describe('resolveRuntimeSelection', () => {
  it('selects Docker when only Docker is reachable', async () => {
    const selection = await resolveRuntimeSelection(
      config(),
      ctx({ home: '/home/u' }),
      probeWith({ 'socket:/home/u/.docker/run/docker.sock': { kind: 'available' } }),
    );
    assert.equal(selection.kind, 'available');
    assert.equal(selection.kind === 'available' && selection.candidate.profile.id, 'docker');
  });

  it('selects Podman when only Podman is reachable', async () => {
    const selection = await resolveRuntimeSelection(
      config(),
      ctx({ home: '/home/u' }),
      probeWith({ 'socket:/run/user/1000/podman/podman.sock': { kind: 'available' } }),
    );
    assert.equal(selection.kind, 'available');
    assert.equal(selection.kind === 'available' && selection.candidate.profile.id, 'podman');
  });

  it('prefers Docker when both are reachable (auto tie-break)', async () => {
    const selection = await resolveRuntimeSelection(
      config(),
      ctx({ home: '/home/u' }),
      probeWith({
        'socket:/home/u/.docker/run/docker.sock': { kind: 'available' },
        'socket:/run/user/1000/podman/podman.sock': { kind: 'available' },
      }),
    );
    assert.equal(selection.kind === 'available' && selection.candidate.profile.id, 'docker');
  });

  it('returns the most actionable failure when none are reachable', async () => {
    // Docker missing, Podman installed-but-stopped → offer to start Podman.
    const selection = await resolveRuntimeSelection(
      config(),
      ctx({ home: '/home/u' }),
      probeWith({ 'socket:/run/user/1000/podman/podman.sock': { kind: 'notRunning' } }),
    );
    assert.equal(selection.kind, 'unavailable');
    if (selection.kind === 'unavailable') {
      assert.equal(selection.candidate.profile.id, 'podman');
      assert.equal(selection.availability.kind, 'notRunning');
    }
  });

  it('breaks an equal-actionability failure toward Docker (candidate order)', async () => {
    const selection = await resolveRuntimeSelection(
      config(),
      ctx({ home: '/home/u' }),
      probeWith({
        'socket:/home/u/.docker/run/docker.sock': { kind: 'notRunning' },
        'socket:/run/user/1000/podman/podman.sock': { kind: 'notRunning' },
      }),
    );
    assert.equal(selection.kind === 'unavailable' && selection.candidate.profile.id, 'docker');
  });

  it('connects to a reachable custom endpoint', async () => {
    const selection = await resolveRuntimeSelection(
      config({ runtime: 'custom', containerHost: 'unix:///run/podman.sock' }),
      ctx(),
      probeWith({ 'socket:/run/podman.sock': { kind: 'available' } }),
    );
    assert.equal(selection.kind, 'available');
    assert.equal(selection.kind === 'available' && selection.candidate.profile.id, 'custom');
  });

  it('passes a configuration error straight through', async () => {
    const selection = await resolveRuntimeSelection(
      config({ runtime: 'custom' }),
      ctx(),
      probeWith({}),
    );
    assert.equal(selection.kind, 'configError');
  });
});
