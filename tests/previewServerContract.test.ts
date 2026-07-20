import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import {
  deleteLocalPreviewSession,
  discoverLocalPreviewSession,
} from '../src/previewServerContract';

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

describe('discoverLocalPreviewSession', () => {
  it('discovers experimental-1 capabilities and creates a session through the authenticated control plane', async () => {
    const requests: Array<{
      method: string;
      path: string;
      authorization?: string;
      body: string;
    }> = [];
    const server = await listen(async (req, res) => {
      const body = await readBody(req);
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: req.headers.authorization,
        body,
      });

      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.headers.authorization !== 'Bearer control-secret') {
        return json(res, 401, {
          error: { code: 'unauthorized', message: 'token required' },
        });
      }
      if (req.url === '/metadata') {
        return json(res, 200, {
          apiVersion: 'experimental-1',
          previewSessionsEndpoint: '/preview-sessions',
          features: {
            renderModes: ['question-only', 'full'],
            defaultRenderMode: 'full',
            grading: true,
            workspaces: true,
            workspaceControls: ['reboot', 'reset'],
          },
        });
      }
      if (req.url === '/preview-sessions' && req.method === 'GET') {
        return json(res, 200, { previewSessions: [] });
      }
      if (req.url === '/preview-sessions' && req.method === 'POST') {
        assert.deepEqual(JSON.parse(body), { courseDir: '/course' });
        return json(res, 201, {
          previewSessionId: 'pvs_0123456789abcdefghijkl',
          courseDir: '/course',
        });
      }
      return json(res, 404, {});
    });

    const descriptor = await discoverLocalPreviewSession({
      origin: origin(server),
      courseDir: '/course',
      authToken: 'control-secret',
      requireWorkspaces: true,
    });

    assert.deepEqual(descriptor, {
      previewSessionId: 'pvs_0123456789abcdefghijkl',
      courseDir: '/course',
    });
    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      ['GET /health', 'GET /metadata', 'GET /preview-sessions', 'POST /preview-sessions'],
    );
    assert.equal(requests[0].authorization, undefined, 'health remains public');
    for (const request of requests.slice(1)) {
      assert.equal(request.authorization, 'Bearer control-secret');
    }
  });

  it('deliberately reuses a listed session for the same canonical course', async () => {
    let posts = 0;
    const descriptor = {
      previewSessionId: 'pvs_0123456789abcdefghijkl',
      courseDir: '/course',
    };
    const server = await listen((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url === '/metadata') return json(res, 200, compatibleMetadata(false));
      if (req.url === '/preview-sessions' && req.method === 'GET') {
        return json(res, 200, { previewSessions: [descriptor] });
      }
      if (req.url === '/preview-sessions' && req.method === 'POST') posts += 1;
      return json(res, 500, {});
    });

    assert.deepEqual(
      await discoverLocalPreviewSession({
        origin: origin(server),
        courseDir: '/course',
        requireWorkspaces: false,
      }),
      descriptor,
    );
    assert.equal(posts, 0);
  });

  it('rejects an old proof-of-concept image before session selection', async () => {
    let sessionCalls = 0;
    const server = await listen((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url === '/metadata') return json(res, 200, { apiVersion: 'proof-of-concept' });
      sessionCalls += 1;
      return json(res, 500, {});
    });

    await assert.rejects(
      discoverLocalPreviewSession({
        origin: origin(server),
        courseDir: '/course',
        requireWorkspaces: false,
      }),
      /does not implement experimental-1/,
    );
    assert.equal(sessionCalls, 0);
  });

  it('rejects incomplete Preview Workspace capabilities before session selection', async () => {
    let sessionCalls = 0;
    const server = await listen((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url === '/metadata') {
        const metadata = compatibleMetadata(true) as {
          features: { workspaceControls: string[] };
        };
        metadata.features.workspaceControls = ['reboot'];
        return json(res, 200, metadata);
      }
      sessionCalls += 1;
      return json(res, 500, {});
    });

    await assert.rejects(
      discoverLocalPreviewSession({
        origin: origin(server),
        courseDir: '/course',
        requireWorkspaces: true,
      }),
      /workspace controls/,
    );
    assert.equal(sessionCalls, 0);
  });
});

describe('deleteLocalPreviewSession', () => {
  it('waits for authenticated session cleanup to complete', async () => {
    let observedAuthorization: string | undefined;
    const server = await listen((req, res) => {
      observedAuthorization = req.headers.authorization;
      assert.equal(req.method, 'DELETE');
      assert.equal(req.url, '/preview-sessions/pvs_0123456789abcdefghijkl');
      res.writeHead(204);
      res.end();
    });

    await deleteLocalPreviewSession({
      origin: origin(server),
      previewSessionId: 'pvs_0123456789abcdefghijkl',
      authToken: 'control-secret',
    });

    assert.equal(observedAuthorization, 'Bearer control-secret');
  });
});

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<http.Server> {
  const server = http.createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function origin(server: http.Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

function compatibleMetadata(workspaces: boolean): unknown {
  return {
    apiVersion: 'experimental-1',
    previewSessionsEndpoint: '/preview-sessions',
    features: {
      renderModes: ['question-only', 'full'],
      defaultRenderMode: 'full',
      grading: true,
      workspaces,
      workspaceControls: workspaces ? ['reboot', 'reset'] : [],
    },
  };
}
