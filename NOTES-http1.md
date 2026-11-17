# HTTP/1.1 fast path (src/http1.ts)

## What changed
`createApp()` no longer returns a `node:http` server. `src/http1.ts` implements the small subset of
HTTP/1.1 this forge needs directly on `net.Socket`:

- request line + headers parsed by hand, headers lower-cased into a plain object;
- bodies read in full before the handler runs: `Content-Length`, `Transfer-Encoding: chunked`,
  and `Expect: 100-continue` (answers `100 Continue` first);
- each response is written as **one** buffer — status line, headers and body together — so a request
  costs a single `socket.write` instead of Node's header/body pair;
- keep-alive by default, `Connection: close` honoured, leftover bytes treated as the next pipelined
  request, `HEAD` answers headers only, HTTP/1.0 closes after the response;
- guards: headers over 64 KiB answer `431`, unparseable requests answer `400`, idle sockets close
  after 75 s, `setNoDelay(true)` on every socket.

`app.ts` keeps every route exactly as it was; only the request/response plumbing and the imports
changed. `main.ts` is untouched.

## Measured (this host, 2026-11-17)
Numbers from `devtools/runbench.ts` (the contest's own benchmark) and per-process `/proc` CPU for the
entry alone, two runs each:

| variant | CPU per request, 4 workloads | CPU per request, 2000 sequential GETs |
|---|---|---|
| `node:http` | 8681 µs | 7640 / 7590 µs |
| this HTTP/1.1 path | **6844 µs** (−21%) | **5550 / 5560 µs** (−27%) |

Raw keep-alive ping, 3000 requests on one socket: p50 1.25–1.85 ms here versus 1.82–2.75 ms on
`node:http`.

`runbench.ts` run in-process on this host is very noisy (the client's own CPU is counted in the same
process), so its `points_total` swings by ±50% between runs and is not a reliable A/B signal; the
per-process CPU and the ping are.

## Verification
- `devtools/runchecks.ts`: **120/120** checks pass (git 30, repos 15, issues 15, pulls 20, protocol 5,
  graphql 20, mcp 15).
- Real `git` against the server: clone, `--depth 1` clone, push of five commits, incremental fetch,
  and a non-fast-forward push refused — all as before.
- Protocol probe: 2000 sequential requests on one socket, `Connection: close`, `HEAD`, chunked body,
  `100-continue`, three pipelined requests in one write, `431`, `400`, JSON `404`, `204`, HTTP/1.0.
