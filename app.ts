// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint, on one
// ephemeral port. app.ts is the router; main.ts keeps the entry <-> env lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGitHttp } from './src/githttp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gitforge-${requestCounter.toString(16).padStart(6, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function hasBearer(req: IncomingMessage): boolean {
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

export function createApp(): Server {
  const forge = new Forge();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = nextRequestId();
    const url = new URL(req.url ?? '/', 'http://forge.local');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

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
      const body = await readBody(req);
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
      const body = await readBody(req);
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
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
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
        query: url.searchParams,
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
      const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
      handleGitHttp(forge, git[1]!, git[2]!, git[3]!, url, method, body, gitProtocol, res);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  };

  return createServer((req, res) => {
    // Small JSON answers dominate the timed workloads; Nagle would delay each of them.
    res.socket?.setNoDelay(true);
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] request failed: ${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
      else res.end();
    });
  });
}
