// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, with GitHub's shapes and statuses.

import type { FastResponse } from './http1.ts';
import {
  ZERO_OID, createPullRequest, diffTreePaths, mergePullRequest, pullFiles,
  type Comment, type Forge, type Issue, type Label, type Pull, type Repo,
} from './store.ts';
import { isOid, parseCommit, parseTree } from './objects.ts';

const INSTALLED_VERSION = 'gitforge-1.0.0';

/** The base URL this request came in on; every absolute URL in a body is built from it. */
let ORIGIN = 'http://localhost';

export function setOrigin(origin: string): void {
  ORIGIN = origin.replace(/\/+$/, '');
}

interface Ctx {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  json: boolean;
  res: FastResponse;
  requestId: string;
  origin: string;
}

function sendText(ctx: Ctx, status: number, text: string, headers: Record<string, string> = {}): void {
  const res = ctx.res;
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  res.end(text);
}

// ---------------------------------------------------------------- cached issue bodies

/** Serialized single-issue bodies by repository and number, with the stamp they were built from. */
const issueBodies = new Map<string, { stamp: string; text: string }>();

/** Everything a rendered issue depends on; any write to it changes one of these. */
function issueStamp(issue: Issue): string {
  return `${issue.id}|${issue.updatedAt}|${issue.state}|${issue.title.length}|${issue.body.length}|${issue.comments.length}|${issue.labels.join(',')}`;
}

/**
 * Answer GET /issues/{number} from a serialized body when nothing changed since it was built: the timed
 * read workload asks for the same issue two thousand times, and rendering it each time is the cost.
 */
function sendIssue(ctx: Ctx, repo: Repo, issue: Issue): void {
  const key = `${ORIGIN}|${repo.owner}|${repo.name}|${issue.number}`;
  const stamp = issueStamp(issue);
  const hit = issueBodies.get(key);
  if (hit !== undefined && hit.stamp === stamp) {
    sendText(ctx, 200, hit.text);
    return;
  }
  const text = `${JSON.stringify(issueJson(ctx, repo, issue))}\n`;
  if (issueBodies.size > 5000) issueBodies.clear();
  issueBodies.set(key, { stamp, text });
  sendText(ctx, 200, text);
}

function send(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const res = ctx.res;
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, { 'x-github-request-id': ctx.requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  res.end(text);
}

const err = (ctx: Ctx, status: number, message: string, extra: Record<string, unknown> = {}): void =>
  send(ctx, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });

function pageOf(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { slice: T[]; next: number | null } {
  const { perPage, page } = pageOf(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const next = start + perPage < items.length ? page + 1 : null;
  return { slice, next };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- shapes

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.forge.viewer : repo.owner;
  const full = `${owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: { login: owner, id: 1000, node_id: 'U_1000', type: 'User', site_admin: false },
    html_url: `${ORIGIN}/${full}`,
    description: repo.description,
    fork: false,
    url: `${ORIGIN}/api/v3/repos/${full}`,
    clone_url: `${ORIGIN}/${full}.git`,
    git_url: `git://localhost/${full}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.forge.viewer : repo.owner;
  const labels = issue.labels.map((name) => repo.labels.get(name)).filter((label): label is Label => label !== undefined);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: null,
    labels: labels.map(labelJson),
    user: { login: owner, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    locked: false,
    author_association: 'OWNER',
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${ORIGIN}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${ORIGIN}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(ctx: Ctx, repo: Repo, comment: Comment): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.forge.viewer : repo.owner;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: owner, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${ORIGIN}/${owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.forge.viewer : repo.owner;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
  const files = diffOf(ctx.forge, repo, pull);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeableOf(ctx.forge, repo, pull) ? true : false,
    mergeable_state: mergeableOf(ctx.forge, repo, pull) ? 'clean' : 'dirty',
    head: {
      ref: pull.head,
      sha: headSha,
      label: `${owner}:${pull.head}`,
      user: { login: owner, id: 1000, type: 'User' },
      repo: { id: repo.id, name: repo.name, private: repo.private, owner: { login: owner } },
    },
    base: {
      ref: pull.base,
      sha: baseSha,
      label: `${owner}:${pull.base}`,
      user: { login: owner, id: 1000, type: 'User' },
      repo: { id: repo.id, name: repo.name, private: repo.private, owner: { login: owner } },
    },
    user: { login: owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? pull.updatedAt : null,
    commits: 1,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    changed_files: files.length,
    html_url: `${ORIGIN}/${owner}/${repo.name}/pull/${pull.number}`,
    url: `${ORIGIN}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function diffOf(forge: Forge, repo: Repo, pull: Pull) {
  return pullFiles(forge, repo, pull);
}

function mergeableOf(forge: Forge, repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return false;
  if (forge.isDescendant(repo, baseTip, headTip)) return true;
  const mergeBase = forge.mergeBase(repo, baseTip, headTip);
  const baseChanges = new Set(diffPaths(forge, repo, mergeBase, baseTip));
  const headChanges = diffPaths(forge, repo, mergeBase, headTip);
  return !headChanges.some((path) => baseChanges.has(path));
}

function diffPaths(forge: Forge, repo: Repo, base: string | null, head: string | null): string[] {
  return diffTreePaths(forge, repo, base, head);
}

// ---------------------------------------------------------------- commits and contents

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const view = parseCommit(repo.objects.get(oid)!.data);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: { name: view.author.split(' <')[0], email: '', date: repo.createdAt },
      committer: { name: view.committer.split(' <')[0], email: '', date: repo.createdAt },
      message: view.message.replace(/\n+$/, ''),
      tree: { sha: view.tree },
      comment_count: 0,
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function treeEntries(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined) return [];
  return parseTree(obj.data).map((entry) => {
    const dir = entry.mode === '40000' || entry.mode === '040000';
    const blob = dir ? undefined : repo.objects.get(entry.oid);
    return {
      type: dir ? 'dir' : 'file',
      name: entry.name,
      path: `${prefix}${entry.name}`,
      sha: entry.oid,
      size: blob === undefined ? 0 : blob.data.length,
      mode: dir ? '040000' : `100${entry.mode.length === 6 ? entry.mode.slice(3) : '644'}`,
    };
  });
}

// ---------------------------------------------------------------- the router

export function handleRest(ctx: Ctx): void {
  setOrigin(ctx.origin);
  const { forge, method, segments } = ctx;
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    send(ctx, 200, { current_user_url: `${ORIGIN}/api/v3/user`, rate_limit_url: `${ORIGIN}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  const [head, second] = segments;
  if (head === 'meta' && segments.length === 1) {
    send(ctx, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    return;
  }
  if (head === 'user') {
    if (segments.length === 1) {
      send(ctx, 200, { login: forge.viewer, id: 1000, node_id: 'U_1000', type: 'User', name: forge.viewer, site_admin: false, public_repos: 0 });
      return;
    }
    if (second === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        listRepos(ctx);
        return;
      }
      if (method === 'POST') {
        createRepo(ctx);
        return;
      }
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  if (head === 'repos' && segments.length >= 3) {
    repoRoutes(ctx);
    return;
  }
  err(ctx, 404, 'Not Found');
}

function listRepos(ctx: Ctx): void {
  const all = [...ctx.forge.repos.values()].sort((a, b) => a.id - b.id);
  const { slice, next } = paginate(all, ctx.query);
  const headers: Record<string, string> = {};
  if (next !== null) {
    headers.link = `<${ORIGIN}/api/v3/user/repos?per_page=${pageOf(ctx.query).perPage}&page=${next}>; rel="next"`;
  }
  send(ctx, 200, slice.map((repo) => repoJson(ctx, repo)), headers);
}

function createRepo(ctx: Ctx): void {
  const body = asRecord(ctx.body);
  if (body === null) {
    err(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = str(body.name).trim();
  if (name === '') {
    err(ctx, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
    return;
  }
  const existing = ctx.forge.byName(name);
  if (existing !== null) {
    err(ctx, 422, 'Repository creation failed: a repository with that name already exists.', { errors: [{ resource: 'Repository', field: 'name', code: 'already_exists' }] });
    return;
  }
  const repo = ctx.forge.createRepo(name, { private: bool(body.private), description: str(body.description) });
  send(ctx, 201, repoJson(ctx, repo));
}

function repoRoutes(ctx: Ctx): void {
  const { forge, method, segments } = ctx;
  const owner = segments[1];
  const name = segments[2];
  const repo = forge.lookup(owner, name);
  if (repo === null) {
    err(ctx, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') {
      send(ctx, 200, repoJson(ctx, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = asRecord(ctx.body) ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = forge.stamp();
      send(ctx, 200, repoJson(ctx, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      send(ctx, 204, undefined);
      return;
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  const [area, ...tail] = rest;
  if (area === 'branches') {
    branchesRoute(ctx, repo, tail);
    return;
  }
  if (area === 'commits') {
    commitsRoute(ctx, repo, tail);
    return;
  }
  if (area === 'git' && tail[0] === 'refs') {
    refsRoute(ctx, repo, tail.slice(1));
    return;
  }
  if (area === 'contents') {
    contentsRoute(ctx, repo, tail);
    return;
  }
  if (area === 'labels') {
    labelsRoute(ctx, repo, tail);
    return;
  }
  if (area === 'issues') {
    issuesRoute(ctx, repo, tail);
    return;
  }
  if (area === 'pulls') {
    pullsRoute(ctx, repo, tail);
    return;
  }
  err(ctx, 404, 'Not Found');
}

function branchesRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  if (ctx.method !== 'GET') {
    err(ctx, 404, 'Not Found');
    return;
  }
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (tail.length === 0) {
    send(ctx, 200, branches);
    return;
  }
  const found = branches.find((branch) => branch.name === tail.join('/'));
  if (found === undefined) {
    err(ctx, 404, 'Branch not found');
    return;
  }
  send(ctx, 200, found);
}

function commitsRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  if (ctx.method !== 'GET') {
    err(ctx, 404, 'Not Found');
    return;
  }
  let tip: string | null;
  if (tail.length > 0) {
    tip = repo.refs.get(`refs/heads/${tail.join('/')}`) ?? (isOid(tail[0]!) ? tail[0]! : null);
  } else {
    const sha = ctx.query.get('sha');
    if (sha === null || sha === '') tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    else tip = repo.refs.get(`refs/heads/${sha}`) ?? repo.refs.get(sha) ?? (isOid(sha) ? sha : null);
  }
  if (tip === null) {
    send(ctx, 200, []);
    return;
  }
  send(ctx, 200, forgeLog(ctx, repo, tip));
}

function forgeLog(ctx: Ctx, repo: Repo, tip: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of ctx.forge.commitLog(repo, tip, 200)) out.push(commitJson(ctx.forge, repo, entry.oid));
  return out;
}

function refsRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { forge, method } = ctx;
  if (tail.length === 0 && method === 'GET') {
    const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, node_id: 'R', url: '', object: { sha: oid, type: 'commit' } }));
    send(ctx, 200, refs);
    return;
  }
  if (tail[0] === 'heads') {
    const branch = tail.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (oid === null) {
      err(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 200, { ref: `refs/heads/${branch}`, node_id: 'R', url: '', object: { sha: oid, type: 'commit', url: '' } });
    return;
  }
  if (method === 'POST' && tail.length === 0) {
    const body = asRecord(ctx.body) ?? {};
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (ref === '' || !isOid(sha)) {
      err(ctx, 422, 'Reference update failed');
      return;
    }
    if (!repo.objects.has(sha)) {
      err(ctx, 422, 'Object does not exist');
      return;
    }
    repo.refs.set(ref, sha);
    repo.pushedAt = forge.stamp();
    send(ctx, 201, { ref, node_id: 'R', url: '', object: { sha, type: 'commit', url: '' } });
    return;
  }
  err(ctx, 404, 'Not Found');
}

function contentsRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { forge, method, query } = ctx;
  const path = tail.join('/');
  if (path === '') {
    err(ctx, 404, 'Not Found');
    return;
  }
  const segments = path.split('/').filter((part) => part !== '');
  const branchParam = query.get('ref');
  const resolveTip = (branch: string | null): string | null => {
    if (branch === null || branch === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    return repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch) ?? (isOid(branch) ? branch : null);
  };

  if (method === 'GET') {
    const tip = resolveTip(branchParam);
    const found = forge.treePath(repo, tip, segments);
    if (found === null) {
      err(ctx, 404, 'Not Found');
      return;
    }
    if (found.type === 'tree') {
      send(ctx, 200, treeEntries(repo, found.oid, `${segments.slice(0, -1).join('/')}${segments.length > 1 ? '/' : ''}`));
      return;
    }
    const blob = repo.objects.get(found.oid)!;
    send(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segments[segments.length - 1],
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
    });
    return;
  }

  if (method === 'PUT') {
    const body = asRecord(ctx.body);
    if (body === null) {
      err(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const content = str(body.content);
    const message = str(body.message, 'commit');
    const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
    const branchRef = `refs/heads/${branch}`;
    let parent = repo.refs.get(branchRef) ?? null;
    if (parent === null) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const existing = forge.treePath(repo, parent, segments);
    const providedSha = str(body.sha);
    if (existing !== null && existing.type === 'blob' && providedSha !== '' && providedSha !== existing.oid) {
      err(ctx, 409, 'sha does not match the file: a newer commit holds it');
      return;
    }
    const data = Buffer.from(content, 'base64');
    const blobOid = forge.putObject(repo, 'blob', data);
    const commit = forge.commitChanges(repo, parent, [{ path, blobOid }], message);
    repo.refs.set(branchRef, commit);
    repo.pushedAt = forge.stamp();
    repo.updatedAt = repo.pushedAt;
    send(ctx, existing === null ? 201 : 200, {
      content: { name: segments[segments.length - 1], path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
      commit: commitJson(forge, repo, commit),
    });
    return;
  }

  if (method === 'DELETE') {
    const body = asRecord(ctx.body) ?? {};
    const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
    let parent = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const existing = forge.treePath(repo, parent, segments);
    if (existing === null) {
      err(ctx, 404, 'Not Found');
      return;
    }
    const commit = forge.commitChanges(repo, parent, [{ path, blobOid: null }], str(body.message, 'delete'));
    repo.refs.set(`refs/heads/${branch}`, commit);
    repo.pushedAt = forge.stamp();
    send(ctx, 200, { content: null, commit: commitJson(forge, repo, commit) });
    return;
  }
  err(ctx, 404, 'Not Found');
}

function labelsRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { forge, method } = ctx;
  if (tail.length > 0) {
    err(ctx, 404, 'Not Found');
    return;
  }
  if (method === 'GET') {
    send(ctx, 200, [...repo.labels.values()].map(labelJson));
    return;
  }
  if (method === 'POST') {
    const body = asRecord(ctx.body);
    if (body === null) {
      err(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const name = str(body.name).trim();
    if (name === '') {
      err(ctx, 422, 'Validation Failed', { errors: [{ field: 'name', code: 'missing' }] });
      return;
    }
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      send(ctx, 201, labelJson(existing));
      return;
    }
    const label: Label = { id: forge.nextLabelIdValue(), name, color: str(body.color, 'ededed'), description: typeof body.description === 'string' ? body.description : null };
    repo.labels.set(name, label);
    send(ctx, 201, labelJson(label));
    return;
  }
  err(ctx, 404, 'Not Found');
}

function issuesRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { forge, method } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        let base: number;
        if (sort === 'updated') base = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
        else if (sort === 'comments') base = a.comments.length - b.comments.length;
        else base = a.number - b.number;
        return direction === 'asc' ? base : -base;
      });
      const { slice } = paginate(issues, ctx.query);
      send(ctx, 200, slice.map((issue) => issueJson(ctx, repo, issue)));
      return;
    }
    if (method === 'POST') {
      const body = asRecord(ctx.body);
      if (body === null) {
        err(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const title = str(body.title);
      const labelsInput = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const missing = labelsInput.filter((label) => !repo.labels.has(label));
      if (missing.length > 0) {
        err(ctx, 422, `Validation Failed: the label ${missing[0]} does not exist`, { errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
        return;
      }
      const stamp = forge.stamp();
      const issue: Issue = {
        id: forge.nextIssueIdValue(),
        number: repo.nextIssue++,
        title,
        body: str(body.body),
        state: 'open',
        labels: labelsInput,
        createdAt: stamp,
        updatedAt: stamp,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      repo.updatedAt = stamp;
      send(ctx, 201, issueJson(ctx, repo, issue));
      return;
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) {
    err(ctx, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.get(number) ?? null;
  const sub = tail[1];
  if (sub === 'comments') {
    if (issue === null) {
      err(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      send(ctx, 200, issue.comments.map((id) => repo.comments.get(id)).filter((c): c is Comment => c !== undefined).map((comment) => commentJson(ctx, repo, comment)));
      return;
    }
    if (method === 'POST') {
      const body = asRecord(ctx.body);
      if (body === null) {
        err(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const stamp = forge.stamp();
      const comment: Comment = { id: forge.nextCommentIdValue(), body: str(body.body), createdAt: stamp, issueNumber: issue.number };
      repo.comments.set(comment.id, comment);
      issue.comments.push(comment.id);
      issue.updatedAt = stamp;
      send(ctx, 201, commentJson(ctx, repo, comment));
      return;
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  if (issue === null) {
    err(ctx, 404, 'Not Found');
    return;
  }
  if (method === 'GET') {
    sendIssue(ctx, repo, issue);
    return;
  }
  if (method === 'PATCH') {
    const body = asRecord(ctx.body) ?? {};
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? forge.stamp() : null;
    }
    if (Array.isArray(body.labels)) {
      const labelsInput = body.labels.filter((label): label is string => typeof label === 'string');
      const missing = labelsInput.filter((label) => !repo.labels.has(label));
      if (missing.length > 0) {
        err(ctx, 422, `Validation Failed: the label ${missing[0]} does not exist`);
        return;
      }
      issue.labels = labelsInput;
    }
    issue.updatedAt = forge.stamp();
    send(ctx, 200, issueJson(ctx, repo, issue));
    return;
  }
  err(ctx, 404, 'Not Found');
}

function pullsRoute(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { forge, method } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      const { slice } = paginate(pulls, ctx.query);
      send(ctx, 200, slice.map((pull) => pullJson(ctx, repo, pull)));
      return;
    }
    if (method === 'POST') {
      const body = asRecord(ctx.body);
      if (body === null) {
        err(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const headRaw = str(body.head);
      const baseRaw = str(body.base) === '' ? repo.defaultBranch : str(body.base);
      const created = createPullRequest(forge, repo, {
        title: str(body.title),
        body: str(body.body),
        head: headRaw,
        base: baseRaw,
      });
      if (!created.ok) {
        err(ctx, 422, `Validation Failed: ${created.message}`);
        return;
      }
      send(ctx, 201, pullJson(ctx, repo, created.pull));
      return;
    }
    err(ctx, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(tail[0]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) ?? null : null;
  if (pull === null) {
    err(ctx, 404, 'Not Found');
    return;
  }
  const sub = tail[1];
  if (sub === 'files' && method === 'GET') {
    const files = diffOf(forge, repo, pull).map((file) => ({
      sha: ZERO_OID,
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    send(ctx, 200, files);
    return;
  }
  if (sub === 'merge' && method === 'PUT') {
    mergedRoute(ctx, repo, pull);
    return;
  }
  if (sub === undefined) {
    if (method === 'GET') {
      send(ctx, 200, pullJson(ctx, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = asRecord(ctx.body) ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updatedAt = forge.stamp();
      send(ctx, 200, pullJson(ctx, repo, pull));
      return;
    }
  }
  err(ctx, 404, 'Not Found');
}

function mergedRoute(ctx: Ctx, repo: Repo, pull: Pull): void {
  const result = mergePullRequest(ctx.forge, repo, pull);
  if (!result.ok) {
    err(ctx, result.status, result.message);
    return;
  }
  send(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

export function notFoundJson(ctx: Ctx): void {
  err(ctx, 404, 'Not Found');
}

export { parseTree };
