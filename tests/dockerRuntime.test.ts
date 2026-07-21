import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import type Docker from 'dockerode';

import { DockerPreviewRuntime } from '../src/dockerRuntime';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('DockerPreviewRuntime shared server lifecycle', () => {
  it('serves multiple course sessions from one container and closes them independently', async () => {
    const controlPlane = await makeControlPlane();
    const fake = new FakeDocker(controlPlane.port);
    const courseA = '/workspace/course-a';
    const courseB = '/workspace/course-b';
    const runtime = new DockerPreviewRuntime({
      courseRoots: [courseA, courseB],
      docker: fake as unknown as Docker,
    });

    const first = await runtime.ensureRunning(courseA);
    const second = await runtime.ensureRunning(courseB);

    assert.equal(fake.createOptions.length, 1, 'both sessions use the same server container');
    assert.equal(first.port, second.port);
    assert.notEqual(first.previewSessionId, second.previewSessionId);
    const courseBinds = fake.createOptions[0].HostConfig?.Binds?.filter((bind) => bind.endsWith(':ro')) ?? [];
    assert.equal(courseBinds.length, 2);
    assert.ok(courseBinds.some((bind) => bind.startsWith(`${courseA}:/courses/`)));
    assert.ok(courseBinds.some((bind) => bind.startsWith(`${courseB}:/courses/`)));

    await runtime.stop(courseA);

    assert.deepEqual(controlPlane.deleted, [first.previewSessionId]);
    assert.equal(fake.containers[0].stopCalls, 0, 'closing one course leaves the shared server running');
    assert.deepEqual(await runtime.ensureRunning(courseB), second);
    const recreated = await runtime.ensureRunning(courseA);
    assert.equal(recreated.port, first.port);
    assert.notEqual(recreated.previewSessionId, first.previewSessionId);
    assert.equal(fake.createOptions.length, 1, 'recreating an evicted session does not restart the server');

    await runtime.stopAll();

    assert.deepEqual(controlPlane.deleted.slice().sort(), [
      first.previewSessionId,
      second.previewSessionId,
      recreated.previewSessionId,
    ].sort());
    assert.equal(fake.containers[0].stopCalls, 1);
  });

  it('restarts once to add a course discovered after the container started', async () => {
    const controlPlane = await makeControlPlane();
    const fake = new FakeDocker(controlPlane.port);
    const courseA = '/workspace/course-a';
    const courseB = '/workspace/course-b';
    const runtime = new DockerPreviewRuntime({
      courseRoots: [courseA],
      docker: fake as unknown as Docker,
    });

    await runtime.ensureRunning(courseA);
    await runtime.ensureRunning(courseB);
    await runtime.ensureRunning(courseA);

    assert.equal(fake.createOptions.length, 2);
    assert.equal(fake.containers[0].stopCalls, 1);
    assert.equal(fake.containers[1].stopCalls, 0);
    const replacementBinds = fake.createOptions[1].HostConfig?.Binds?.filter((bind) => bind.endsWith(':ro')) ?? [];
    assert.equal(replacementBinds.length, 2);

    await runtime.stopAll();
  });
});

class FakeDocker {
  readonly containers: FakeContainer[] = [];
  readonly createOptions: Docker.ContainerCreateOptions[] = [];
  readonly modem = {
    demuxStream() {},
  };

  constructor(private readonly port: number) {}

  async createContainer(options: Docker.ContainerCreateOptions): Promise<FakeContainer> {
    this.createOptions.push(options);
    const container = new FakeContainer(`container-${this.containers.length + 1}`, this.port);
    this.containers.push(container);
    return container;
  }
}

class FakeContainer {
  stopCalls = 0;

  constructor(
    private readonly id: string,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {}

  async inspect(): Promise<unknown> {
    return {
      Id: this.id,
      NetworkSettings: {
        Ports: {
          '4310/tcp': [{ HostIp: '127.0.0.1', HostPort: String(this.port) }],
        },
      },
    };
  }

  async logs(): Promise<never> {
    throw new Error('log streaming unavailable in fake');
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async remove(): Promise<void> {}
}

async function makeControlPlane(): Promise<{
  deleted: string[];
  port: number;
}> {
  const deleted: string[] = [];
  const sessions = new Map<string, { courseDir: string; previewSessionId: string }>();
  let nextSession = 1;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.url === '/metadata') {
      return json(res, 200, {
        apiVersion: 'experimental-1',
        previewSessionsEndpoint: '/preview-sessions',
        features: {
          renderModes: ['question-only', 'full'],
          defaultRenderMode: 'full',
          grading: true,
          workspaces: false,
          workspaceControls: [],
        },
      });
    }
    if (req.url === '/preview-sessions' && req.method === 'GET') {
      return json(res, 200, { previewSessions: [...sessions.values()] });
    }
    if (req.url === '/preview-sessions' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { courseDir: string };
      const previewSessionId = `pvs_${String(nextSession++).padStart(22, '0')}`;
      const descriptor = { courseDir: body.courseDir, previewSessionId };
      sessions.set(previewSessionId, descriptor);
      return json(res, 201, descriptor);
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/preview-sessions/')) {
      const previewSessionId = req.url.slice('/preview-sessions/'.length);
      deleted.push(previewSessionId);
      sessions.delete(previewSessionId);
      res.writeHead(204);
      res.end();
      return;
    }
    return json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { deleted, port: (server.address() as AddressInfo).port };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
