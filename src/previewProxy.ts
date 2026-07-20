import { once } from 'node:events';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface PreviewProxyOptions {
  /** Real preview-server origin, e.g. `http://127.0.0.1:49812`. */
  targetOrigin: string;
  /** Token embedded in rewritten question HTML and accepted by the webview shell. */
  workspaceBridgeToken: string;
  /** Optional log sink for non-fatal proxy failures. */
  log?: (message: string) => void;
}

/**
 * Narrow reverse proxy in front of the preview server.
 *
 * It passes non-HTML responses through unchanged and rewrites only rendered
 * question HTML below a Local Preview Session to intercept PrairieLearn's
 * workspace button.
 */
export class PreviewProxy {
  private readonly server: http.Server;
  private readonly targetOrigin: URL;
  private readonly workspaceBridgeToken: string;
  private readonly log: (message: string) => void;
  private listeningPort: number | undefined;

  constructor({ targetOrigin, workspaceBridgeToken, log = () => {} }: PreviewProxyOptions) {
    this.targetOrigin = new URL(targetOrigin);
    if (this.targetOrigin.protocol !== 'http:') {
      throw new Error(`unsupported preview proxy target protocol: ${this.targetOrigin.protocol}`);
    }
    this.workspaceBridgeToken = workspaceBridgeToken;
    this.log = log;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    if (this.listeningPort != null) return;
    this.server.listen(0, LOOPBACK_HOST);
    await once(this.server, 'listening');
    const address = this.server.address() as AddressInfo;
    this.listeningPort = address.port;
  }

  get port(): number {
    if (this.listeningPort == null) {
      throw new Error('preview proxy has not started');
    }
    return this.listeningPort;
  }

  get origin(): string {
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  urlFor(targetUrl: string): string {
    const url = new URL(targetUrl);
    if (url.origin !== this.targetOrigin.origin) {
      throw new Error(`cannot proxy URL from unexpected origin: ${url.origin}`);
    }
    return `${this.origin}${url.pathname}${url.search}${url.hash}`;
  }

  async dispose(): Promise<void> {
    if (this.listeningPort == null) return;
    this.listeningPort = undefined;
    this.server.closeAllConnections?.();
    this.server.close();
    await once(this.server, 'close');
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const targetUrl = new URL(req.url ?? '/', this.targetOrigin);
    const headers = requestHeadersForTarget(req.headers, this.targetOrigin.host);

    const proxyReq = http.request(
      targetUrl,
      {
        headers,
        method: req.method,
      },
      (proxyRes) => {
        const responseHeaders = responseHeadersForClient(proxyRes.headers, this.targetOrigin.origin, this.origin);
        const contentType = headerValue(proxyRes.headers['content-type']);
        const shouldRewrite =
          /^\/preview-sessions\/[^/]+\/questions(?:\/|$)/.test(targetUrl.pathname) &&
          (contentType == null || /\btext\/html\b/i.test(contentType));

        if (!shouldRewrite) {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders);
          proxyRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const rewritten = rewritePreviewQuestionHtml(body, {
            targetOrigin: this.targetOrigin.origin,
            workspaceBridgeToken: this.workspaceBridgeToken,
          });
          responseHeaders['content-length'] = String(Buffer.byteLength(rewritten));
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, responseHeaders);
          res.end(rewritten);
        });
      },
    );

    proxyReq.on('error', (err) => {
      this.log(`[pl-preview] preview proxy request failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Preview proxy request failed.');
    });

    req.pipe(proxyReq);
  }
}

export interface RewritePreviewQuestionHtmlOptions {
  targetOrigin: string;
  workspaceBridgeToken: string;
}

export function rewritePreviewQuestionHtml(
  html: string,
  { targetOrigin, workspaceBridgeToken }: RewritePreviewQuestionHtmlOptions,
): string {
  const script = workspaceBridgeScript({ targetOrigin, workspaceBridgeToken });
  const bodyClose = /<\/body\s*>/i;
  if (bodyClose.test(html)) return html.replace(bodyClose, `${script}\n</body>`);
  return `${html}\n${script}`;
}

function workspaceBridgeScript({ targetOrigin, workspaceBridgeToken }: RewritePreviewQuestionHtmlOptions): string {
  return `<script>
(() => {
  const workspaceBridgeToken = ${JSON.stringify(workspaceBridgeToken)};
  const workspaceTargetOrigin = ${JSON.stringify(targetOrigin)};
  const workspacePathPattern = /(^|\\/)workspace\\/[^/?#]+\\/?$/;

  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!anchor) return;
    if (!/\\bopen\\s+workspace\\b/i.test(anchor.textContent || '')) return;
    const href = anchor.getAttribute('href');
    if (!href || href === '#') return;

    let hrefUrl;
    try {
      hrefUrl = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (!workspacePathPattern.test(hrefUrl.pathname)) return;

    const workspaceUrl = new URL(hrefUrl.pathname + hrefUrl.search + hrefUrl.hash, workspaceTargetOrigin).toString();
    event.preventDefault();
    window.parent.postMessage(
      { type: 'plPreview.openWorkspace', token: workspaceBridgeToken, url: workspaceUrl },
      '*',
    );
  });
})();
</script>`;
}

function requestHeadersForTarget(headers: IncomingHttpHeaders, targetHost: string): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host') continue;
    forwarded[key] = value;
  }
  forwarded.host = targetHost;
  forwarded['accept-encoding'] = 'identity';
  return forwarded;
}

function responseHeadersForClient(
  headers: IncomingHttpHeaders,
  targetOrigin: string,
  proxyOrigin: string,
): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'content-encoding') continue;
    if (lower === 'content-length') continue;
    if (lower === 'location' && typeof value === 'string') {
      forwarded[key] = rewriteLocationHeader(value, targetOrigin, proxyOrigin);
      continue;
    }
    forwarded[key] = value;
  }
  return forwarded;
}

function rewriteLocationHeader(location: string, targetOrigin: string, proxyOrigin: string): string {
  try {
    const url = new URL(location, targetOrigin);
    if (url.origin !== targetOrigin) return location;
    return `${proxyOrigin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return location;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
