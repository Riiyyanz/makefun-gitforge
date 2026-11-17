// A minimal HTTP/1.1 server on `net.Socket`, standing in for `node:http` on the request path.
//
// The shapes the router needs are small on purpose: the connection layer reads the head, reads the
// whole body (content-length or chunked), calls the handler once with everything in hand, and then
// writes status line + headers + body as a single Buffer in one `socket.write`. Keep-alive is the
// default; a second request already buffered on the socket is parsed as soon as the first answer is
// written, so pipelining stays safe without any queue.

import { EventEmitter } from 'node:events';
import { createServer, type Server as NetServer, type Socket } from 'node:net';

export interface FastRequest {
  method: string;
  /** Raw path, percent-encoded, the way `URL.pathname` reports it. */
  path: string;
  /** Raw query string without its leading `?` ('' when there is none). */
  search: string;
  query: URLSearchParams;
  /** Header names lower-cased; a repeated header is joined with ', '. */
  headers: Record<string, string>;
  /** The whole request body, already read. Never decoded as text. */
  body: Buffer;
}

export interface FastResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string | number>): void;
  end(body?: Buffer | string): void;
  readonly socket: { setNoDelay(on?: boolean): void };
}

export type FastHandler = (req: FastRequest, res: FastResponse) => void | Promise<void>;

const EMPTY = Buffer.alloc(0);
const EMPTY_QUERY = new URLSearchParams();
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 75_000;
// Responses at or below this size go out as one write; a big git pack is sliced instead of copied.
const ONE_WRITE_LIMIT = 1024 * 1024;
const WRITE_SLICE = 1024 * 1024;
// Past this many pipelined requests handled in one synchronous burst, yield before continuing.
const MAX_SYNC_DEPTH = 64;

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

const S_HEAD = 0;
const S_LENGTH = 1;
const S_CHUNKED = 2;
const S_BUSY = 3;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The Date header only changes once a second; render it once per second. */
let dateCache = '';
let dateSecond = -1;
function dateValue(): string {
  const second = Math.floor(Date.now() / 1000);
  if (second !== dateSecond) {
    dateSecond = second;
    dateCache = new Date(second * 1000).toUTCString();
  }
  return dateCache;
}

/** Incremental `Transfer-Encoding: chunked` body decoder: feed slices, get the bytes after the body. */
class ChunkedBody {
  done = false;
  private state = 0; // 0 = size line, 1 = data, 2 = CRLF, 3 = trailer
  private remaining = 0;
  private total = 0;
  private chunks: Buffer[] = [];
  private line: number[] = [];

  /** Consume as much of `input` as belongs to the body; returns the bytes after it. */
  push(input: Buffer): Buffer {
    let offset = 0;
    for (;;) {
      if (this.state === 1) {
        const take = Math.min(this.remaining, input.length - offset);
        if (take > 0) {
          this.chunks.push(input.subarray(offset, offset + take));
          this.total += take;
          if (this.total > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
          offset += take;
          this.remaining -= take;
        } else if (this.remaining > 0) {
          return EMPTY;
        }
        if (this.remaining > 0) return EMPTY;
        this.state = 2;
      }
      // The remaining states all read one CRLF-terminated line.
      const read = this.takeLine(input, offset);
      offset = read.next;
      if (read.line === null) return EMPTY;
      if (this.state === 0) {
        const semi = read.line.indexOf(';');
        const sizeText = (semi === -1 ? read.line : read.line.slice(0, semi)).trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new HttpError(400, 'Malformed chunk size');
        const size = Number.parseInt(sizeText, 16);
        if (size === 0) this.state = 3;
        else {
          this.remaining = size;
          this.state = 1;
        }
      } else if (this.state === 2) {
        this.state = 0;
      } else if (this.state === 3) {
        if (read.line === '') {
          this.done = true;
          return offset === input.length ? EMPTY : input.subarray(offset);
        }
      }
    }
  }

  buffer(): Buffer {
    return this.chunks.length === 0 ? EMPTY : Buffer.concat(this.chunks, this.total);
  }

  private takeLine(input: Buffer, offset: number): { line: string | null; next: number } {
    for (let index = offset; index < input.length; index += 1) {
      const byte = input[index]!;
      if (byte === 10) {
        const line = Buffer.from(this.line).toString('latin1');
        this.line.length = 0;
        return { line, next: index + 1 };
      }
      if (byte !== 13) {
        this.line.push(byte);
        if (this.line.length > 256) throw new HttpError(400, 'Malformed chunk header');
      }
    }
    return { line: null, next: input.length };
  }
}

/** One response. `writeHead` records; `end` renders and writes it in a single call. */
class Response implements FastResponse {
  headersSent = false;
  ended = false;
  status = 200;
  headers: Record<string, string | number> | null = null;
  readonly socket: { setNoDelay(on?: boolean): void };
  private readonly conn: Connection;
  readonly method: string;
  readonly keepAlive: boolean;

  constructor(conn: Connection, method: string, keepAlive: boolean, socket: { setNoDelay(on?: boolean): void }) {
    this.conn = conn;
    this.method = method;
    this.keepAlive = keepAlive;
    this.socket = socket;
  }

  writeHead(status: number, headers: Record<string, string | number>): void {
    if (this.headersSent) return;
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    this.headersSent = true;
    const payload = body === undefined ? EMPTY : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    this.conn.finish(this, payload);
  }
}

class Connection {
  readonly socket: Socket;
  private readonly server: Http1Server;
  private buf: Buffer = EMPTY;
  private state = S_HEAD;
  active = false;
  dead = false;
  closing = false;

  private method = 'GET';
  private path = '/';
  private search = '';
  private query: URLSearchParams = EMPTY_QUERY;
  private headers: Record<string, string> = {};
  private reqKeepAlive = true;
  private bodyChunks: Buffer[] = [];
  private bodySize = 0;
  private remaining = 0;
  private decoder: ChunkedBody | null = null;
  private depth = 0;
  private readonly facade: { setNoDelay(on?: boolean): void };

  constructor(server: Http1Server, socket: Socket) {
    this.server = server;
    this.socket = socket;
    this.facade = {
      setNoDelay(on?: boolean): void {
        socket.setNoDelay(on ?? true);
      },
    };
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => {
      // A handler still working on an answer is not an idle connection; give it another window.
      if (this.active) socket.setTimeout(IDLE_TIMEOUT_MS);
      else this.destroy();
    });
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => {
      this.dead = true;
      server.connections.delete(this);
    });
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.socket.destroy();
  }

  // ------------------------------------------------------------------ reading

  private feed(chunk: Buffer): void {
    if (this.dead) return;
    if (this.state === S_BUSY) {
      // Pipelined bytes for the next request; they wait until this answer is written.
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      return;
    }
    let input = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.buf = EMPTY;
    this.depth += 1;
    try {
      for (;;) {
        if (this.dead) return;
        if (this.state === S_HEAD) {
          const end = this.parseHead(input);
          if (end < 0) {
            this.buf = input;
            return;
          }
          input = end === input.length ? EMPTY : input.subarray(end);
          continue;
        }
        if (this.state === S_LENGTH) {
          if (this.remaining > 0) {
            if (input.length === 0) {
              this.buf = EMPTY;
              return;
            }
            const take = Math.min(this.remaining, input.length);
            this.bodyChunks.push(take === input.length ? input : input.subarray(0, take));
            this.bodySize += take;
            this.remaining -= take;
            input = take === input.length ? EMPTY : input.subarray(take);
            if (this.remaining > 0) {
              this.buf = input;
              return;
            }
          }
          this.dispatch();
          // A synchronous answer has already reset the state: keep parsing what is left (pipelining).
          if (this.state === S_BUSY) {
            this.buf = input;
            return;
          }
          continue;
        }
        if (this.state === S_CHUNKED) {
          const rest = this.decoder!.push(input);
          if (!this.decoder!.done) {
            this.buf = rest;
            return;
          }
          this.dispatch();
          if (this.state === S_BUSY) {
            this.buf = rest;
            return;
          }
          input = rest;
          continue;
        }
        return;
      }
    } catch (error) {
      this.abort(error);
    } finally {
      this.depth -= 1;
    }
  }

  /** Parse one request head out of `input`; returns the offset just past it, or -1 for "need more". */
  private parseHead(input: Buffer): number {
    let headerEnd = input.indexOf('\r\n\r\n');
    let terminator = 4;
    if (headerEnd === -1) {
      headerEnd = input.indexOf('\n\n');
      terminator = 2;
    }
    if (headerEnd === -1) {
      if (input.length > MAX_HEADER_BYTES) throw new HttpError(431, 'Request header fields too large');
      return -1;
    }
    if (headerEnd > MAX_HEADER_BYTES) throw new HttpError(431, 'Request header fields too large');

    const text = input.toString('latin1', 0, headerEnd);
    const next = headerEnd + terminator;
    const lines = text.split('\n');

    // A lone CRLF before the request line is legal and is skipped.
    let index = 0;
    let startLine = '';
    while (index < lines.length) {
      const line = lines[index]!.endsWith('\r') ? lines[index]!.slice(0, -1) : lines[index]!;
      index += 1;
      if (line !== '') {
        startLine = line;
        break;
      }
    }
    if (startLine === '') throw new HttpError(400, 'Malformed request line');

    const firstSpace = startLine.indexOf(' ');
    const lastSpace = startLine.lastIndexOf(' ');
    if (firstSpace <= 0 || lastSpace <= firstSpace) throw new HttpError(400, 'Malformed request line');
    const method = startLine.slice(0, firstSpace);
    const target = startLine.slice(firstSpace + 1, lastSpace);
    const version = startLine.slice(lastSpace + 1);
    if (target === '') throw new HttpError(400, 'Malformed request line');
    if (!/^[A-Z]+$/.test(method)) throw new HttpError(400, 'Malformed method');
    if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') throw new HttpError(400, 'Unsupported HTTP version');

    const headers: Record<string, string> = {};
    for (; index < lines.length; index += 1) {
      const raw = lines[index]!;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') continue;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new HttpError(400, 'Malformed header line');
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const prior = headers[name];
      headers[name] = prior === undefined ? value : `${prior}, ${value}`;
    }

    let keepAlive = version === 'HTTP/1.1';
    const connection = headers.connection;
    if (connection !== undefined) {
      const lower = connection.toLowerCase();
      if (lower.includes('close')) keepAlive = false;
      else if (lower.includes('keep-alive')) keepAlive = true;
    }

    let path = target;
    let search = '';
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const absolute = new URL(path);
      path = absolute.pathname;
      search = absolute.search.slice(1);
    } else {
      const question = path.indexOf('?');
      if (question !== -1) {
        search = path.slice(question + 1);
        path = path.slice(0, question);
      }
    }
    if (path === '') path = '/';

    const encoding = headers['transfer-encoding'];
    let chunked = false;
    let bodyLength = 0;
    if (encoding !== undefined && encoding.toLowerCase().includes('chunked')) {
      chunked = true;
    } else {
      const declared = headers['content-length'];
      if (declared !== undefined) {
        if (!/^\d+$/.test(declared)) throw new HttpError(400, 'Invalid Content-Length');
        bodyLength = Number(declared);
        if (bodyLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
      }
    }

    const expect = headers.expect;
    if (expect !== undefined && expect.toLowerCase().includes('100-continue') && (chunked || bodyLength > 0)) {
      this.socket.write(CONTINUE);
    }

    this.method = method;
    this.path = path;
    this.search = search;
    this.query = search === '' ? EMPTY_QUERY : new URLSearchParams(search);
    this.headers = headers;
    this.reqKeepAlive = keepAlive;
    this.bodyChunks = [];
    this.bodySize = 0;
    this.decoder = null;

    if (chunked) {
      this.decoder = new ChunkedBody();
      this.state = S_CHUNKED;
      return next;
    }
    this.remaining = bodyLength;
    this.state = S_LENGTH;
    return next;
  }

  // ------------------------------------------------------------------ answering

  private dispatch(): void {
    this.state = S_BUSY;
    this.active = true;
    let body = EMPTY;
    if (this.decoder !== null) {
      body = this.decoder.buffer();
      this.decoder = null;
    } else if (this.bodySize > 0) {
      body = Buffer.concat(this.bodyChunks, this.bodySize);
    }
    this.bodyChunks = [];
    this.bodySize = 0;

    const req: FastRequest = {
      method: this.method,
      path: this.path,
      search: this.search,
      query: this.query,
      headers: this.headers,
      body,
    };
    const res = new Response(this, this.method, this.reqKeepAlive, this.facade);
    let outcome: void | Promise<void>;
    try {
      outcome = this.server.handler(req, res);
    } catch (error) {
      this.failed(res, error);
      return;
    }
    if (outcome !== undefined && typeof (outcome as Promise<void>).then === 'function') {
      (outcome as Promise<void>).then(
        () => this.settled(res),
        (error: unknown) => this.failed(res, error),
      );
    } else {
      this.settled(res);
    }
  }

  /** The handler returned without ending the response: never leave the request hanging. */
  private settled(res: Response): void {
    if (res.ended) return;
    this.server.warn('handler returned without calling end()');
    if (res.headersSent) {
      res.end();
      return;
    }
    const body = Buffer.from(`${JSON.stringify({ message: 'Internal Server Error' })}\n`, 'utf8');
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }

  private failed(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.server.warn(`request failed: ${message}`);
    if (res.ended) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    const body = Buffer.from(`${JSON.stringify({ message: 'Internal Server Error' })}\n`, 'utf8');
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
    });
    res.end(body);
  }

  /** A parse-level failure: answer with JSON, then drop the connection (the stream is unusable). */
  private abort(error: unknown): void {
    if (this.dead) return;
    const status = error instanceof HttpError ? error.status : 400;
    const message = error instanceof Error ? error.message : 'Bad Request';
    const text = `${JSON.stringify({ message })}\n`;
    const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n`;
    const body = Buffer.from(text, 'utf8');
    const headBuf = Buffer.from(head, 'latin1');
    if (this.socket.writable) this.socket.write(Buffer.concat([headBuf, body], headBuf.length + body.length));
    this.dead = true;
    this.socket.end();
    this.server.connections.delete(this);
  }

  finish(res: Response, payload: Buffer): void {
    if (this.dead) return;
    const status = res.status;
    const isHead = res.method === 'HEAD';
    // HEAD keeps the headers a GET would send (content-length included) and only drops the body.
    const noBody = isHead || status === 204 || status === 304;
    const bodyless = status === 204 || status === 304;
    const keepAlive = res.keepAlive && !this.closing && !this.server.closing;
    const headers = res.headers ?? {};
    const hasLength = Object.hasOwn(headers, 'content-length');

    let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Status'}\r\n`;
    if (!bodyless && !hasLength) head += `content-length: ${payload.length}\r\n`;
    head += `date: ${dateValue()}\r\n`;
    if (!keepAlive) head += 'connection: close\r\n';
    for (const name of Object.keys(headers)) {
      if (bodyless && name === 'content-length') continue;
      head += `${name}: ${headers[name]}\r\n`;
    }
    head += '\r\n';

    const headBuf = Buffer.from(head, 'latin1');
    const socket = this.socket;
    if (noBody || payload.length === 0) {
      if (socket.writable) socket.write(headBuf);
    } else if (payload.length <= ONE_WRITE_LIMIT) {
      const framed = Buffer.concat([headBuf, payload], headBuf.length + payload.length);
      if (socket.writable) socket.write(framed);
    } else {
      // A git pack can be tens of MiB; slicing avoids copying it into a second buffer.
      if (socket.writable) {
        socket.write(headBuf);
        for (let offset = 0; offset < payload.length; offset += WRITE_SLICE) {
          const slice = payload.subarray(offset, Math.min(offset + WRITE_SLICE, payload.length));
          socket.write(slice);
        }
      }
    }

    this.active = false;
    if (!keepAlive) {
      this.dead = true;
      socket.end();
      return;
    }
    this.state = S_HEAD;
    const pending = this.buf;
    if (pending.length > 0) {
      this.buf = EMPTY;
      if (this.depth >= MAX_SYNC_DEPTH) {
        setImmediate(() => {
          if (!this.dead) this.feed(pending);
        });
      } else {
        this.feed(pending);
      }
    }
  }
}

export class Http1Server extends EventEmitter {
  readonly connections = new Set<Connection>();
  readonly handler: FastHandler;
  closing = false;
  private readonly net: NetServer;

  constructor(handler: FastHandler) {
    super();
    this.handler = handler;
    this.net = createServer((socket: Socket) => {
      const conn = new Connection(this, socket);
      this.connections.add(conn);
    });
    this.net.on('listening', () => this.emit('listening'));
    this.net.on('error', (error: Error) => this.emit('error', error));
    this.net.on('close', () => this.emit('close'));
  }

  listen(...args: unknown[]): this {
    (this.net.listen as (...a: unknown[]) => NetServer).apply(this.net, args);
    return this;
  }

  address(): ReturnType<NetServer['address']> {
    return this.net.address();
  }

  close(callback?: (error?: Error) => void): this {
    this.closing = true;
    for (const conn of this.connections) {
      conn.closing = true;
      if (!conn.active) conn.destroy();
    }
    this.net.close((error?: Error) => {
      callback?.(error);
    });
    return this;
  }

  closeAllConnections(): void {
    for (const conn of this.connections) conn.destroy();
  }

  closeIdleConnections(): void {
    for (const conn of this.connections) {
      if (!conn.active) conn.destroy();
    }
  }

  warn(message: string): void {
    process.stderr.write(`[forge] ${message}\n`);
  }
}

export function createHttpServer(handler: FastHandler): Http1Server {
  return new Http1Server(handler);
}
