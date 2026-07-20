import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { PreviewProxy, rewritePreviewQuestionHtml } from '../src/previewProxy';

const servers: http.Server[] = [];
const proxies: PreviewProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('rewritePreviewQuestionHtml', () => {
  it('injects a workspace click bridge before the body close', () => {
    const html = rewritePreviewQuestionHtml(
      '<html><body><a href="/preview-sessions/pvs_0123456789abcdefghijkl/workspace/1">Open workspace</a></body></html>',
      {
        targetOrigin: 'http://127.0.0.1:49812',
        workspaceBridgeToken: 'token-1',
      },
    );

    assert.match(html, /workspaceBridgeToken = "token-1"/);
    assert.match(html, /workspaceTargetOrigin = "http:\/\/127\.0\.0\.1:49812"/);
    assert.match(html, /plPreview\.openWorkspace/);
    assert.match(html, /<\/script>\n<\/body>/);
  });
});

describe('PreviewProxy', () => {
  it('rewrites session-scoped question HTML responses and keeps assets untouched', async () => {
    const sessionPrefix = '/preview-sessions/pvs_0123456789abcdefghijkl';
    const upstream = await startServer((req, res) => {
      if (req.url?.startsWith(`${sessionPrefix}/questions/demo`)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body><a target="_blank" href="${sessionPrefix}/workspace/1">Open workspace</a></body></html>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-demo': 'asset' });
      res.end('asset body');
    });

    const proxy = await startProxy(upstream.origin, 'bridge-token');
    const question = await fetch(`${proxy.origin}${sessionPrefix}/questions/demo?variant=1`);
    const questionHtml = await question.text();
    assert.match(questionHtml, /bridge-token/);
    assert.match(questionHtml, /plPreview\.openWorkspace/);

    const asset = await fetch(`${proxy.origin}${sessionPrefix}/preview-render/course.css`);
    assert.equal(asset.headers.get('x-demo'), 'asset');
    assert.equal(await asset.text(), 'asset body');
  });

  it('maps proxied question URLs back to the real preview origin', async () => {
    const proxy = await startProxy('http://127.0.0.1:49812', 'token');
    const pathname = '/preview-sessions/pvs_0123456789abcdefghijkl/questions/demo?variant=1';

    assert.equal(proxy.urlFor(`http://127.0.0.1:49812${pathname}`), `${proxy.origin}${pathname}`);
    assert.throws(() => proxy.urlFor(`http://127.0.0.1:60000${pathname}`));
  });

  it('rewrites absolute redirects from the preview server back through the proxy', async () => {
    const pathname = '/preview-sessions/pvs_0123456789abcdefghijkl/questions/next?variant=1';
    const upstream = await startServer((_req, res) => {
      res.writeHead(302, { location: `${upstream.origin}${pathname}` });
      res.end();
    });
    const proxy = await startProxy(upstream.origin, 'token');

    const response = await fetch(`${proxy.origin}${pathname}`, {
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${proxy.origin}${pathname}`);
  });
});

async function startProxy(targetOrigin: string, workspaceBridgeToken: string): Promise<PreviewProxy> {
  const proxy = new PreviewProxy({ targetOrigin, workspaceBridgeToken });
  await proxy.start();
  proxies.push(proxy);
  return proxy;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string }> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}` };
}
