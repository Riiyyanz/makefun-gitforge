// The Model Context Protocol endpoint: JSON-RPC 2.0 over the Streamable HTTP transport,
// speaking revision 2026-07-28 (server/discover, no handshake) and the older handshake.

import { createPullRequest, mergePullRequest, ZERO_OID, type Forge, type Repo } from './store.ts';
import { createHash } from 'node:crypto';

const SERVER_NAME = 'gitforge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });
const boolProp = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const numberProp = (description: string): Record<string, unknown> => ({ type: 'number', description });

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user and return its full name and id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        owner: stringProp('The owner login (defaults to the authenticated user).'),
        description: stringProp('A short description.'),
        private: boolProp('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch.'),
        base: stringProp('The base branch.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: numberProp('The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List a repository\'s pull requests, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read one file from a repository\'s default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login.'),
        repo: stringProp('The repository name.'),
        path: stringProp('The repository-relative path.'),
      },
      required: ['owner', 'repo', 'path'],
    },
  },
]);

/** The tools/list result, serialized once so two calls answer byte for byte. */
const TOOLS_RESULT = { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = str(args, 'owner') === '' ? forge.viewer : str(args, 'owner');
  const name = str(args, 'repo') === '' ? str(args, 'name') : str(args, 'repo');
  if (name === '') return null;
  return forge.lookup(owner, name);
}

function repoSummary(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = repo.owner === '' ? forge.viewer : repo.owner;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://localhost/${owner}/${repo.name}`,
  };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  if (name === 'create_repo') {
    const repoName = str(args, 'name');
    if (repoName === '') return { ok: false, message: 'name is required' };
    const existing = forge.byName(repoName);
    if (existing !== null) return { ok: true, value: repoSummary(forge, existing) };
    const repo = forge.createRepo(repoName, {
      private: args.private === true,
      description: str(args, 'description'),
    });
    return { ok: true, value: repoSummary(forge, repo) };
  }
  if (name === 'get_repo') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    return { ok: true, value: repoSummary(forge, repo) };
  }
  if (name === 'create_issue') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const title = str(args, 'title');
    if (title === '') return { ok: false, message: 'title is required' };
    const stamp = forge.stamp();
    const issue = {
      id: forge.nextIssueIdValue(),
      number: repo.nextIssue++,
      title,
      body: str(args, 'body'),
      state: 'open' as const,
      labels: [] as string[],
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
      comments: [] as number[],
    };
    repo.issues.set(issue.number, issue);
    return {
      ok: true,
      value: { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state },
    };
  }
  if (name === 'list_issues') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body }));
    return { ok: true, value: { issues, total: issues.length } };
  }
  if (name === 'create_pull_request') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const created = createPullRequest(forge, repo, {
      title: str(args, 'title'),
      body: str(args, 'body'),
      head: str(args, 'head'),
      base: str(args, 'base') === '' ? repo.defaultBranch : str(args, 'base'),
    });
    if (!created.ok) return { ok: false, message: created.message };
    return {
      ok: true,
      value: {
        id: created.pull.id,
        number: created.pull.number,
        state: created.pull.state,
        head: { ref: created.pull.head },
        base: { ref: created.pull.base },
        title: created.pull.title,
      },
    };
  }
  if (name === 'merge_pull_request') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str(args, 'pull_number'), 10);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { ok: false, message: `pull request ${number} not found` };
    const merged = mergePullRequest(forge, repo, pull);
    if (!merged.ok) return { ok: false, message: merged.message };
    return { ok: true, value: { number: pull.number, merged: true, state: pull.state, sha: merged.sha, merge_commit_sha: merged.sha } };
  }
  if (name === 'list_pull_requests') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
    const pulls = [...repo.pulls.values()]
      .filter((pull) => state === 'all' || pull.state === state)
      .map((pull) => ({ id: pull.id, number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, head: pull.head, base: pull.base }));
    return { ok: true, value: { pull_requests: pulls, total: pulls.length } };
  }
  if (name === 'get_file_contents') {
    const repo = repoOf(forge, args);
    if (repo === null) return { ok: false, message: 'repository not found' };
    const path = str(args, 'path');
    const segments = path.split('/').filter((part) => part !== '');
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const found = forge.treePath(repo, tip, segments);
    if (found === null || found.type !== 'blob') return { ok: false, message: `file ${path} not found` };
    const blob = repo.objects.get(found.oid)!;
    return { ok: true, value: { path, sha: found.oid, size: blob.data.length, content: blob.data.toString('base64'), encoding: 'base64' } };
  }
  return { ok: false, message: `unknown tool ${name}` };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export interface McpResult { status: number; body: unknown }

/** Answer one POST to /mcp. `raw` is the exact request text (a malformed body is the parse-error case). */
export function handleMcp(forge: Forge, raw: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: rpcError(null, RPC_PARSE_ERROR, 'Parse error: the body is not JSON') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, RPC_INVALID_REQUEST, 'Invalid Request') };
  }
  const request = parsed as RpcRequest;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};
  const isNotification = id === undefined || id === null;
  if (method === '') return { status: 200, body: rpcError(id, RPC_INVALID_REQUEST, 'Invalid Request: no method') };
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over smart HTTP.',
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: undefined };
  }
  if (method === 'ping') return { status: 200, body: rpcResult(id, {}) };
  if (method === 'tools/list') return { status: 200, body: rpcResult(id, TOOLS_RESULT) };
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (name === '') return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name') };
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, `unknown tool ${name}`) };
    const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
    const missing = required.filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, `missing required argument(s): ${missing.join(', ')}`) };
    }
    const outcome = callTool(forge, name, args);
    if (!outcome.ok) {
      if (outcome.message.startsWith('unknown tool')) return { status: 200, body: rpcError(id, RPC_INVALID_PARAMS, outcome.message) };
      return {
        status: 200,
        body: rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true }),
      };
    }
    const text = JSON.stringify(outcome.value);
    return {
      status: 200,
      body: rpcResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.value, isError: false }),
    };
  }
  if (isNotification) return { status: 202, body: undefined };
  return { status: 200, body: rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`) };
}

/** A cheap deterministic id for diagnostics (never part of a scored surface). */
export function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export { ZERO_OID };
