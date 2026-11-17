// Entry point for the forge: it owns the process <-> env lifecycle and nothing else.
//
// The env (the contest harness) starts this process, then waits for it to say "I am up, here is
// my address". Everything the forge actually answers lives in app.ts; this file only:
//   1. reads MAKEFUN_ENV_URL,
//   2. starts the app on an ephemeral port,
//   3. POSTs that port to <env>/register,
//   4. polls <env>/done until the suite is finished,
//   5. closes the server and exits 0.
// No npm dependencies, no model calls, no flags beyond --experimental-strip-types.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

// Every env request gets its own deadline so a hung socket can never wedge the lifecycle.
const ENV_REQUEST_TIMEOUT_MS = 30_000;
// Bounded exponential backoff for retries: ~250 ms first, never longer than ~2 s.
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2_000;
// How long close() may wait for in-flight requests before connections are torn down.
const CLOSE_GRACE_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Small stderr helper: diagnostics only, never stdout (stdout stays clean for the harness).
const warn = (message: string): void => {
  process.stderr.write(`[gitforge] ${message}\n`);
};

// ---------------------------------------------------------------------------------------------
// Step 1: read MAKEFUN_ENV_URL. Absent or empty means there is nobody to register with, and the
// process is useless, so say so on stderr and leave with code 1.
// ---------------------------------------------------------------------------------------------
function readEnvUrl(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (typeof raw !== 'string') return null;
  // Tolerate a trailing slash ("http://host:8080/") by stripping all of them before joining paths.
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

// One JSON request with its own timeout. Resolves with status + parsed body; throws only on
// network-level failures (DNS, refused, reset) or a timeout, which the callers treat as retryable.
async function envRequest(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(ENV_REQUEST_TIMEOUT_MS) });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is not fatal: the status code usually carries the answer.
    body = null;
  }
  return { status: response.status, body };
}

const isDoneBody = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;

// ---------------------------------------------------------------------------------------------
// Step 2: build the app and listen on port 0, letting the kernel pick an ephemeral port. Port 8080
// belongs to the env, so it must never be bound here. Resolves once the socket is really listening.
// ---------------------------------------------------------------------------------------------
async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null || address.port <= 0) {
    throw new Error('server did not report a listening port');
  }
  return { server, port: address.port };
}

// ---------------------------------------------------------------------------------------------
// Step 3: tell the env where we listen. 2xx means registered; 409 means another entry got there
// first, which is not an error for us either — we just carry on. Anything else (or a timeout) is
// retried with bounded exponential backoff, forever: the env may still be starting up.
// ---------------------------------------------------------------------------------------------
async function registerWithEnv(envUrl: string, port: number): Promise<void> {
  const body = JSON.stringify({ port });
  let delay = BACKOFF_START_MS;

  for (;;) {
    try {
      const { status } = await envRequest(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      });

      if (status >= 200 && status < 300) {
        warn(`registered on port ${port}`);
        return;
      }
      if (status === 409) {
        // Another entry already registered: ours is not needed, but the lifecycle continues.
        warn('register returned 409 (already registered), continuing');
        return;
      }
      warn(`register answered ${status}, retrying in ${delay} ms`);
    } catch (error) {
      warn(`register failed (${(error as Error).message}), retrying in ${delay} ms`);
    }

    await sleep(delay);
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 4: poll <env>/done until it says {"done": true}. While the suite runs the env answers
// {"done": false} immediately, so this is a plain poll. A fast "false" keeps the short interval;
// only failures and slow/failed requests escalate the backoff. We never exit before done.
// ---------------------------------------------------------------------------------------------
async function waitForEnvDone(envUrl: string): Promise<void> {
  let delay = BACKOFF_START_MS;

  for (;;) {
    try {
      const { status, body } = await envRequest(`${envUrl}/done`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (status >= 200 && status < 300 && isDoneBody(body)) return;
      // Healthy answer, suite still running: stay on the fast cadence.
      delay = BACKOFF_START_MS;
    } catch (error) {
      warn(`done poll failed (${(error as Error).message}), retrying in ${delay} ms`);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      await sleep(delay);
      continue;
    }
    await sleep(delay);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 5 / signals: stop accepting connections, give in-flight ones a brief grace period, then
// exit with the requested code. Idempotent, so a signal during shutdown cannot double-exit.
// ---------------------------------------------------------------------------------------------
let shuttingDown = false;

function shutdown(server: Server, code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const grace = setTimeout(() => {
    // Grace expired: drop whatever is still connected so the process can really go away.
    server.closeAllConnections();
    process.exit(code);
  }, CLOSE_GRACE_MS);
  grace.unref?.();
  server.close(() => {
    clearTimeout(grace);
    process.exit(code);
  });
}

async function main(): Promise<void> {
  // Step 1: no env URL, no reason to run.
  const envUrl = readEnvUrl();
  if (envUrl === null) {
    warn('MAKEFUN_ENV_URL is unset or empty; nothing to register with, exiting');
    process.exit(1);
  }

  // Step 2: app on an ephemeral port.
  const { server, port } = await listenOnEphemeralPort();

  // Signals close the server and leave cleanly instead of dying on the default handler.
  const onSignal = (signal: string): void => {
    warn(`${signal} received, shutting down`);
    shutdown(server, 0);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // Step 3: announce the address.
  await registerWithEnv(envUrl, port);

  // Step 4: serve until the suite is done.
  await waitForEnvDone(envUrl);

  // Step 5: done means nobody else is coming; drain briefly and exit 0.
  warn('env reported done, closing server');
  shutdown(server, 0);
}

main().catch((error: unknown) => {
  // Anything that escapes the retry loops is a genuine bug, not a network hiccup.
  warn(`fatal: ${(error as Error).message}`);
  process.exit(1);
});
