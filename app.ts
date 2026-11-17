// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint, on one
// ephemeral port. app.ts is the router; main.ts keeps the entry <-> env lifecycle.

import { createHttpServer, type FastRequest, type FastResponse, type Http1Server } from './src/http1.ts';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGitHttp } from './src/githttp.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gitforge-${requestCounter.toString(16).padStart(6, '0')}`;
}

function sendJson(res: FastResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function hasBearer(req: FastRequest): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer\s+\S+/i.test(header);
}

function decodeSegments(pathname: string): string[] {
  return pathname.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function createApp(): Http1Server {
  const forge = new Forge();

  const handle = (req: FastRequest, res: FastResponse): void => {
    const requestId = nextRequestId();
    const pathname = req.path;
    const method = req.method;

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    if (pathname === '/api/graphql') {
      if (!hasBearer(req)) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' }, requestId);
        return;
      }
      const body = req.body;
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
        return;
      }
      const result = handleGraphQL(forge, payload);
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        if (!hasBearer(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestId);
          return;
        }
        res.writeHead(204, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' }, requestId, { allow: 'POST, DELETE' });
        return;
      }
      if (!hasBearer(req)) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }
      const body = req.body;
      const result = handleMcp(forge, body.toString('utf8'));
      if (result.body === undefined) {
        res.writeHead(result.status, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (!hasBearer(req)) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }
      const body = req.body;
      let parsed: unknown = undefined;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
          return;
        }
      }
      const segments = decodeSegments(pathname).slice(1);
      const rest = segments.slice(2);
      handleRest({
        forge,
        method,
        segments: rest,
        query: req.query,
        body: parsed,
        json: true,
        res,
        requestId,
        origin: `http://${req.headers.host ?? 'localhost'}`,
      });
      return;
    }

    const git = GIT_PATH.exec(pathname);
    if (git !== null) {
      const body = method === 'POST' ? req.body : Buffer.alloc(0);
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
      const url = new URL(`${pathname}${req.search === '' ? '' : `?${req.search}`}`, 'http://forge.local');
      handleGitHttp(forge, git[1]!, git[2]!, git[3]!, url, method, body, gitProtocol, res);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  };

  return createHttpServer((req, res) => {
    // Nagle is already off: src/http1.ts sets it once per connection, where the socket is created.
    try {
      handle(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] request failed: ${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
      else res.end();
    }
  });
}
