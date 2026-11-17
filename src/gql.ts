// GitHub GraphQL v4: a small document parser and executor for the documents `gh` and
// github-mcp-server send — viewer, repository, issue and pull-request reads, the create/close/
// merge mutations, __type introspection, Relay node() and operation batching.

import {
  createPullRequest, mergePullRequest, pullFiles, type Forge, type Issue, type Pull, type Repo,
} from './store.ts';
import { parseCommit } from './objects.ts';

// ---------------------------------------------------------------- ids

export function encodeId(kind: string, value: number | string): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64');
}

export function decodeId(id: string): { kind: string; value: string } | null {
  const text = Buffer.from(id, 'base64').toString('utf8');
  const at = text.indexOf(':');
  if (at <= 0) return null;
  return { kind: text.slice(0, at), value: text.slice(at + 1) };
}

export const repoGlobalId = (repo: Repo): string => encodeId('Repository', repo.id);
export const issueGlobalId = (issue: Issue): string => encodeId('Issue', issue.id);
export const pullGlobalId = (pull: Pull): string => encodeId('PullRequest', pull.id);
export const commentGlobalId = (id: number): string => encodeId('IssueComment', id);

// ---------------------------------------------------------------- lexer and parser

type Token = { type: 'name' | 'number' | 'string' | 'punct'; value: string };

const PUNCT = new Set(['{', '}', '(', ')', ':', '[', ']', '$', '!', '=', '@', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.startsWith('...', i)) { tokens.push({ type: 'punct', value: '...' }); i += 3; continue; }
    if (PUNCT.has(ch)) { tokens.push({ type: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ type: 'string', value: end < 0 ? source.slice(i + 3) : source.slice(i + 3, end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1] ?? '';
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
          continue;
        }
        text += source[j];
        j += 1;
      }
      tokens.push({ type: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

type GValue =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GValue[] }
  | { kind: 'obj'; fields: Record<string, GValue> };

interface GArg { name: string; value: GValue }
type GSelection =
  | { kind: 'field'; alias: string | null; name: string; args: GArg[]; selections: GSelection[] }
  | { kind: 'inline'; typeName: string; selections: GSelection[] };

export interface GOperation { type: 'query' | 'mutation'; selections: GSelection[] }

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private next(): Token | undefined { return this.tokens[this.index++]; }
  private at(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.value === value;
  }
  private take(value: string): void {
    if (this.at(value)) this.index += 1;
  }

  document(): GOperation[] {
    const operations: GOperation[] = [];
    while (this.index < this.tokens.length) operations.push(this.operation());
    return operations;
  }

  private operation(): GOperation {
    const token = this.peek();
    let type: 'query' | 'mutation' = 'query';
    if (token !== undefined && token.type === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      this.next();
      if (token.value === 'mutation') type = 'mutation';
      if (this.peek()?.type === 'name') this.next();
      if (this.at('(')) this.skipBalanced('(', ')');
      while (this.at('@')) { this.next(); if (this.peek()?.type === 'name') this.next(); if (this.at('(')) this.skipBalanced('(', ')'); }
    } else if (token !== undefined && token.type === 'name' && token.value === 'fragment') {
      this.next();
      if (this.peek()?.type === 'name') this.next();
      if (this.peek()?.type === 'name' && this.peek()!.value === 'on') { this.next(); if (this.peek()?.type === 'name') this.next(); }
      if (this.at('{')) this.selectionSet();
      return { type: 'query', selections: [] };
    }
    return { type, selections: this.at('{') ? this.selectionSet() : [] };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token === undefined) return;
      if (token.value === open) depth += 1;
      else if (token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private selectionSet(): GSelection[] {
    const selections: GSelection[] = [];
    if (!this.at('{')) return selections;
    this.next();
    while (this.index < this.tokens.length && !this.at('}')) {
      if (this.at('...')) {
        this.next();
        if (this.peek()?.type === 'name' && this.peek()!.value === 'on') {
          this.next();
          const typeName = this.peek()?.value ?? '';
          if (this.peek()?.type === 'name') this.next();
          selections.push({ kind: 'inline', typeName, selections: this.at('{') ? this.selectionSet() : [] });
        } else if (this.at('{')) {
          selections.push({ kind: 'inline', typeName: '*', selections: this.selectionSet() });
        } else {
          if (this.peek()?.type === 'name') this.next();
        }
        continue;
      }
      const first = this.next();
      if (first === undefined || first.type !== 'name') continue;
      let alias: string | null = null;
      let name = first.value;
      if (this.at(':')) {
        this.next();
        alias = name;
        name = this.next()?.value ?? name;
      }
      const args: GArg[] = [];
      if (this.at('(')) {
        this.next();
        while (this.index < this.tokens.length && !this.at(')')) {
          const argName = this.next()?.value ?? '';
          this.take(':');
          args.push({ name: argName, value: this.value() });
        }
        this.take(')');
      }
      while (this.at('@')) { this.next(); if (this.peek()?.type === 'name') this.next(); if (this.at('(')) this.skipBalanced('(', ')'); }
      const selectionsHere = this.at('{') ? this.selectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: selectionsHere });
    }
    this.take('}');
    return selections;
  }

  private value(): GValue {
    const token = this.next();
    if (token === undefined) return { kind: 'null' };
    if (token.type === 'punct' && token.value === '$') return { kind: 'var', name: this.next()?.value ?? '' };
    if (token.type === 'string') return { kind: 'str', value: token.value };
    if (token.type === 'number') return { kind: 'num', value: Number(token.value) };
    if (token.type === 'punct' && token.value === '[') {
      const items: GValue[] = [];
      while (this.index < this.tokens.length && !this.at(']')) items.push(this.value());
      this.take(']');
      return { kind: 'list', items };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Record<string, GValue> = {};
      while (this.index < this.tokens.length && !this.at('}')) {
        const key = this.next()?.value ?? '';
        this.take(':');
        fields[key] = this.value();
      }
      this.take('}');
      return { kind: 'obj', fields };
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    return { kind: 'null' };
  }
}

export function parseDocument(source: string): GOperation[] {
  return new Parser(lex(source)).document();
}

// ---------------------------------------------------------------- the schema table

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'databaseId', 'url', 'avatarUrl', 'email', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'pushedAt', 'url', 'isFork', 'stargazerCount', 'forkCount', 'visibility',
  ],
  Ref: ['name', 'target', 'prefix'],
  Commit: ['oid', 'message', 'abbreviatedOid', 'committedDate', 'authoredDate'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url', 'stateReason'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'isDraft',
    'additions', 'deletions', 'changedFiles', 'url', 'author', 'commits',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['name', 'color', 'description', 'id'],
  LabelConnection: ['nodes', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

// ---------------------------------------------------------------- execution

interface FieldError { message: string; path: Array<string | number> }

class Exec {
  readonly errors: FieldError[] = [];
  readonly forge: Forge;
  readonly variables: Record<string, unknown>;

  constructor(forge: Forge, variables: Record<string, unknown>) {
    this.forge = forge;
    this.variables = variables;
  }

  value(value: GValue): unknown {
    switch (value.kind) {
      case 'var': return this.variables[value.name];
      case 'str': return value.value;
      case 'num': return value.value;
      case 'bool': return value.value;
      case 'null': return null;
      case 'enum': return value.value;
      case 'list': return value.items.map((item) => this.value(item));
      case 'obj': {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value.fields)) out[key] = this.value(item);
        return out;
      }
      default: return null;
    }
  }

  args(args: readonly GArg[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of args) out[arg.name] = this.value(arg.value);
    return out;
  }

  project(value: unknown, selections: readonly GSelection[], path: Array<string | number>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((item, index) => this.project(item, selections, [...path, index]));
    return this.resolveSet(value as Node, selections, path);
  }

  resolveSet(source: Node, selections: readonly GSelection[], path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const typeName = source.__type;
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (selection.typeName !== '*' && selection.typeName !== typeName) continue;
        Object.assign(out, this.resolveSet(source, selection.selections, path));
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const resolver = RESOLVERS[typeName]?.[selection.name];
      if (resolver === undefined) {
        this.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
        out[key] = null;
        continue;
      }
      const args = this.args(selection.args);
      let value: unknown;
      try {
        value = resolver(source, args, this);
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = selection.selections.length > 0 ? this.project(value, selection.selections, [...path, key]) : value;
    }
    return out;
  }
}

interface Node { __type: string; [key: string]: unknown }
type Resolver = (source: Node, args: Record<string, unknown>, exec: Exec) => unknown;
type ResolverTable = Record<string, Record<string, Resolver>>;

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function nodeRepo(source: Node): Repo { return source.repo as Repo; }
function nodeIssue(source: Node): Issue { return source.issue as Issue; }
function nodePull(source: Node): Pull { return source.pull as Pull; }

function repositoryNode(repo: Repo): Node { return { __type: 'Repository', repo }; }
function issueNode(repo: Repo, issue: Issue): Node { return { __type: 'Issue', repo, issue }; }
function pullNode(repo: Repo, pull: Pull): Node { return { __type: 'PullRequest', repo, pull }; }

function findIssueById(forge: Forge, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(forge: Forge, id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

/** The connection helper: a slice plus GitHub's pageInfo. */
function connection(nodes: Node[], args: Record<string, unknown>, kind: string): Node {
  const first = asNumber(args.first, nodes.length);
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null && after !== '') {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const at = decoded.lastIndexOf(':');
    const index = at >= 0 ? Number.parseInt(decoded.slice(at + 1), 10) : Number.NaN;
    if (Number.isFinite(index)) start = Math.min(nodes.length, index + 1);
  }
  const slice = nodes.slice(start, start + Math.max(0, first));
  const lastIndex = start + slice.length - 1;
  return {
    __type: kind,
    nodes: slice,
    totalCount: nodes.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + slice.length < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : Buffer.from(`${kind}:${start}`).toString('base64'),
      endCursor: slice.length === 0 ? null : Buffer.from(`${kind}:${lastIndex}`).toString('base64'),
    },
  };
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  const states = asArray(args.states).map((state) => String(state));
  let issues = [...repo.issues.values()];
  if (states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = asString(orderBy.field, 'CREATED_AT');
  const direction = asString(orderBy.direction, 'DESC');
  issues.sort((a, b) => {
    if (field === 'UPDATED_AT') return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
    if (field === 'COMMENTS') return a.comments.length - b.comments.length || a.number - b.number;
    return a.number - b.number;
  });
  if (direction !== 'ASC') issues.reverse();
  return issues;
}

function repoForNode(exec: Exec, owner: unknown, name: unknown): Repo | null {
  const repoName = asString(name);
  if (repoName === '') return null;
  const exportOwner = asString(owner);
  if (exec.forge.login === null) return exec.forge.lookup(exportOwner, repoName);
  if (exportOwner !== exec.forge.login) return null;
  return exec.forge.byName(repoName);
}

const RESOLVERS: ResolverTable = {
  Query: {
    viewer: (_source, _args, exec) => ({ __type: 'User', login: exec.forge.viewer }),
    repository: (_source, args, exec) => {
      const repo = repoForNode(exec, args.owner, args.name);
      return repo === null ? null : repositoryNode(repo);
    },
    node: (_source, args, exec) => {
      const decoded = decodeId(asString(args.id));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = exec.forge.repoById(Number(decoded.value));
        return repo === null ? null : repositoryNode(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueById(exec.forge, Number(decoded.value));
        return found === null ? null : issueNode(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullById(exec.forge, Number(decoded.value));
        return found === null ? null : pullNode(found.repo, found.pull);
      }
      return null;
    },
    __type: (_source, args) => ({ __type: '__Type', name: asString(args.name) }),
    rateLimit: () => ({ __type: 'RateLimit', limit: 5000, remaining: 4999, resetAt: '2025-01-01T00:00:00Z' }),
  },
  Mutation: {
    createIssue: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.repositoryId));
      const repo = decoded === null ? null : exec.forge.repoById(Number(decoded.value));
      if (repo === null) throw new Error('Could not resolve to a Repository with the provided id');
      const stamp = exec.forge.stamp();
      const issue: Issue = {
        id: exec.forge.nextIssueIdValue(),
        number: repo.nextIssue++,
        title: asString(input.title),
        body: asString(input.body),
        state: 'open',
        labels: asArray(input.labelIds).map((value) => String(value)),
        createdAt: stamp,
        updatedAt: stamp,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.issueId));
      const found = decoded === null ? null : findIssueById(exec.forge, Number(decoded.value));
      if (found === null) throw new Error('Could not resolve to an Issue with the provided id');
      found.issue.state = 'closed';
      found.issue.closedAt = exec.forge.stamp();
      found.issue.updatedAt = found.issue.closedAt;
      return { __type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    reopenIssue: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.issueId));
      const found = decoded === null ? null : findIssueById(exec.forge, Number(decoded.value));
      if (found === null) throw new Error('Could not resolve to an Issue with the provided id');
      found.issue.state = 'open';
      found.issue.closedAt = null;
      found.issue.updatedAt = exec.forge.stamp();
      return { __type: 'ReopenIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    updateIssue: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.issueId));
      const found = decoded === null ? null : findIssueById(exec.forge, Number(decoded.value));
      if (found === null) throw new Error('Could not resolve to an Issue with the provided id');
      if (typeof input.title === 'string') found.issue.title = input.title;
      if (typeof input.body === 'string') found.issue.body = input.body;
      found.issue.updatedAt = exec.forge.stamp();
      return { __type: 'UpdateIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.repositoryId));
      const repo = decoded === null ? null : exec.forge.repoById(Number(decoded.value));
      if (repo === null) throw new Error('Could not resolve to a Repository with the provided id');
      const created = createPullRequest(exec.forge, repo, {
        title: asString(input.title),
        body: asString(input.body),
        head: asString(input.headRefName),
        base: asString(input.baseRefName),
      });
      if (!created.ok) throw new Error(created.message);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created.pull) };
    },
    mergePullRequest: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.pullRequestId));
      const found = decoded === null ? null : findPullById(exec.forge, Number(decoded.value));
      if (found === null) throw new Error('Could not resolve to a PullRequest with the provided id');
      const merged = mergePullRequest(exec.forge, found.repo, found.pull);
      if (!merged.ok) throw new Error(merged.message);
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (_source, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(asString(input.subjectId));
      const found = decoded === null ? null : findIssueById(exec.forge, Number(decoded.value));
      if (found === null) throw new Error('Could not resolve to an Issue with the provided id');
      const comment = {
        id: exec.forge.nextCommentIdValue(),
        body: asString(input.body),
        createdAt: exec.forge.stamp(),
        issueNumber: found.issue.number,
      };
      found.repo.comments.set(comment.id, comment);
      found.issue.comments.push(comment.id);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', comment },
      };
    },
  },
  User: {
    login: (source, _args, exec) => asString(source.login, exec.forge.viewer),
    id: () => encodeId('User', 1000),
    name: (source, _args, exec) => asString(source.login, exec.forge.viewer),
    databaseId: () => 1000,
    url: () => 'http://localhost/api/v3/user',
    isViewer: () => true,
  },
  Repository: {
    id: (source) => repoGlobalId(nodeRepo(source)),
    databaseId: (source) => nodeRepo(source).id,
    name: (source) => nodeRepo(source).name,
    nameWithOwner: (source, _args, exec) => `${nodeRepo(source).owner === '' ? exec.forge.viewer : nodeRepo(source).owner}/${nodeRepo(source).name}`,
    owner: (source, _args, exec) => ({ __type: 'User', login: nodeRepo(source).owner === '' ? exec.forge.viewer : nodeRepo(source).owner }),
    defaultBranchRef: (source) => {
      const repo = nodeRepo(source);
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __type: 'Ref', name: repo.defaultBranch, oid: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (source) => nodeRepo(source).private,
    description: (source) => nodeRepo(source).description,
    createdAt: (source) => nodeRepo(source).createdAt,
    pushedAt: (source) => nodeRepo(source).pushedAt,
    url: (source, _args, exec) => `http://localhost/${nodeRepo(source).owner === '' ? exec.forge.viewer : nodeRepo(source).owner}/${nodeRepo(source).name}`,
    isFork: () => false,
    stargazerCount: () => 0,
    forkCount: () => 0,
    visibility: (source) => (nodeRepo(source).private ? 'PRIVATE' : 'PUBLIC'),
    issue: (source, args) => {
      const repo = nodeRepo(source);
      const issue = repo.issues.get(asNumber(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (source, args) => {
      const repo = nodeRepo(source);
      return connection(sortedIssues(repo, args).map((issue) => issueNode(repo, issue)), args, 'IssueConnection');
    },
    pullRequests: (source, args) => {
      const repo = nodeRepo(source);
      const states = asArray(args.states).map((state) => String(state));
      let pulls = [...repo.pulls.values()];
      pulls = states.length > 0 ? pulls.filter((pull) => states.includes(pull.state.toUpperCase())) : pulls.filter((pull) => pull.state === 'open');
      pulls.sort((a, b) => a.number - b.number);
      return connection(pulls.map((pull) => pullNode(repo, pull)), args, 'PullRequestConnection');
    },
    pullRequest: (source, args) => {
      const repo = nodeRepo(source);
      const pull = repo.pulls.get(asNumber(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  Ref: {
    name: (source) => asString(source.name),
    prefix: () => 'refs/heads/',
    target: (source) => (typeof source.oid === 'string' ? { __type: 'Commit', oid: source.oid } : null),
  },
  Commit: {
    oid: (source, _args, exec) => {
      const oid = asString(source.oid);
      void exec;
      return oid;
    },
    abbreviatedOid: (source) => asString(source.oid).slice(0, 7),
    message: (source, _args, exec) => {
      const repo = nodeRepo(source);
      const obj = repo.objects.get(asString(source.oid));
      return obj === undefined ? '' : parseCommit(obj.data).message;
    },
  },
  Issue: {
    id: (source) => issueGlobalId(nodeIssue(source)),
    number: (source) => nodeIssue(source).number,
    title: (source) => nodeIssue(source).title,
    state: (source) => nodeIssue(source).state.toUpperCase(),
    stateReason: (source) => (nodeIssue(source).state === 'closed' ? 'COMPLETED' : null),
    body: (source) => nodeIssue(source).body,
    createdAt: (source) => nodeIssue(source).createdAt,
    updatedAt: (source) => nodeIssue(source).updatedAt,
    closedAt: (source) => nodeIssue(source).closedAt,
    url: (source) => `http://localhost/issues/${nodeIssue(source).number}`,
    author: (source, _args, exec) => ({ __type: 'User', login: nodeRepo(source).owner === '' ? exec.forge.viewer : nodeRepo(source).owner }),
    comments: (source, args) => {
      const repo = nodeRepo(source);
      const nodes: Node[] = [];
      for (const id of nodeIssue(source).comments) {
        const comment = repo.comments.get(id);
        if (comment !== undefined) nodes.push({ __type: 'IssueComment', comment });
      }
      return connection(nodes, args, 'IssueCommentConnection');
    },
    labels: (source) => ({
      __type: 'LabelConnection',
      nodes: nodeIssue(source).labels.map((name) => ({ __type: 'Label', name })),
      totalCount: nodeIssue(source).labels.length,
    }),
  },
  IssueConnection: {
    nodes: (source) => asArray(source.nodes),
    edges: (source) => asArray(source.nodes).map((node, index) => ({ __type: 'IssueEdge', node, index })),
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => asNumber(source.totalCount),
  },
  IssueEdge: {
    node: (source) => source.node,
    cursor: (source) => Buffer.from(`IssueConnection:${asNumber(source.index)}`).toString('base64'),
  },
  IssueComment: {
    id: (source) => commentGlobalId(asNumber(source.comment?.id)),
    body: (source) => asString(source.comment?.body),
    createdAt: (source) => asString(source.comment?.createdAt),
    author: (_source, _args, exec) => ({ __type: 'User', login: exec.forge.viewer }),
    url: () => 'http://localhost/comment',
  },
  IssueCommentConnection: {
    nodes: (source) => asArray(source.nodes).map((comment) => ({ __type: 'IssueComment', comment })),
    totalCount: (source) => asArray(source.nodes).length,
  },
  IssueCommentEdge: {
    node: (source) => ({ __type: 'IssueComment', comment: source.comment }),
  },
  PullRequest: {
    id: (source) => pullGlobalId(nodePull(source)),
    number: (source) => nodePull(source).number,
    title: (source) => nodePull(source).title,
    state: (source) => (nodePull(source).merged ? 'MERGED' : nodePull(source).state.toUpperCase()),
    merged: (source) => nodePull(source).merged,
    mergedAt: (source) => nodePull(source).mergedAt,
    createdAt: (source) => nodePull(source).createdAt,
    updatedAt: (source) => nodePull(source).updatedAt,
    closedAt: (source) => (nodePull(source).state === 'closed' ? nodePull(source).mergedAt : null),
    body: (source) => nodePull(source).body,
    headRefName: (source) => nodePull(source).head,
    baseRefName: (source) => nodePull(source).base,
    isDraft: () => false,
    url: (source) => `http://localhost/pull/${nodePull(source).number}`,
    mergeable: (source, _args, exec) => {
      const repo = nodeRepo(source);
      const pull = nodePull(source);
      if (pull.merged) return 'UNKNOWN';
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
      if (!exec.forge.isDescendant(repo, baseTip, headTip) && pullFiles(exec.forge, repo, pull).length === 0) return 'CONFLICTING';
      return 'MERGEABLE';
    },
    files: (source, args, exec) => {
      const files = pullFiles(exec.forge, nodeRepo(source), nodePull(source));
      return connection(files.map((file) => ({ __type: 'PullRequestChangedFile', file })), args, 'PullRequestChangedFileConnection');
    },
    mergeCommit: (source) => (nodePull(source).mergeCommitSha === null ? null : { __type: 'Commit', oid: nodePull(source).mergeCommitSha }),
    additions: (source, _args, exec) => pullFiles(exec.forge, nodeRepo(source), nodePull(source)).reduce((total, file) => total + file.additions, 0),
    deletions: (source, _args, exec) => pullFiles(exec.forge, nodeRepo(source), nodePull(source)).reduce((total, file) => total + file.deletions, 0),
    changedFiles: (source, _args, exec) => pullFiles(exec.forge, nodeRepo(source), nodePull(source)).length,
    author: (source, _args, exec) => ({ __type: 'User', login: nodeRepo(source).owner === '' ? exec.forge.viewer : nodeRepo(source).owner }),
  },
  PullRequestConnection: {
    nodes: (source) => asArray(source.nodes),
    edges: (source) => asArray(source.nodes).map((node, index) => ({ __type: 'PullRequestEdge', node, index })),
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => asNumber(source.totalCount),
  },
  PullRequestEdge: {
    node: (source) => source.node,
    cursor: (source) => Buffer.from(`PullRequestConnection:${asNumber(source.index)}`).toString('base64'),
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => asArray(source.nodes),
    totalCount: (source) => asArray(source.nodes).length,
  },
  PullRequestChangedFile: {
    path: (source) => asString((source.file as Record<string, unknown>)?.path),
    additions: (source) => asNumber((source.file as Record<string, unknown>)?.additions),
    deletions: (source) => asNumber((source.file as Record<string, unknown>)?.deletions),
    changeType: (source) => String((source.file as Record<string, unknown>)?.status ?? 'MODIFIED').toUpperCase(),
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage === true,
    hasPreviousPage: (source) => source.hasPreviousPage === true,
    startCursor: (source) => source.startCursor ?? null,
    endCursor: (source) => source.endCursor ?? null,
  },
  Label: {
    name: (source) => asString(source.name),
    color: () => 'ededed',
    description: () => null,
    id: (source) => encodeId('Label', asString(source.name)),
  },
  LabelConnection: {
    nodes: (source) => asArray(source.nodes),
    totalCount: (source) => asArray(source.nodes).length,
  },
  CreateIssuePayload: { issue: (source) => source.issue, clientMutationId: () => null },
  CloseIssuePayload: { issue: (source) => source.issue, clientMutationId: () => null },
  ReopenIssuePayload: { issue: (source) => source.issue, clientMutationId: () => null },
  UpdateIssuePayload: { issue: (source) => source.issue, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest, clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge,
    clientMutationId: () => null,
    subject: (source) => (source.commentEdge === undefined ? null : null),
  },
  __Type: {
    name: (source) => asString(source.name),
    kind: (source) => (ENUM_VALUES[asString(source.name)] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (source) => {
      const fields = OBJECT_FIELDS[asString(source.name)];
      return fields === undefined ? null : fields.map((name) => ({ __type: '__Field', name }));
    },
    enumValues: (source) => {
      const values = ENUM_VALUES[asString(source.name)];
      return values === undefined ? null : values.map((name) => ({ __type: '__EnumValue', name }));
    },
    interfaces: () => [],
    possibleTypes: () => null,
  },
  __Field: { name: (source) => asString(source.name), description: () => null, isDeprecated: () => false, deprecationReason: () => null },
  __EnumValue: { name: (source) => asString(source.name), description: () => null, isDeprecated: () => false, deprecationReason: () => null },
  RateLimit: { limit: () => 5000, remaining: () => 4999, resetAt: () => '2025-01-01T00:00:00Z' },
};

// ---------------------------------------------------------------- the endpoint

export interface GqlResult { status: number; body: unknown }

function runOperation(forge: Forge, operation: GOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const exec = new Exec(forge, variables);
  const root: Node = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = exec.resolveSet(root, operation.selections, []);
  return exec.errors.length === 0 ? { data } : { data, errors: exec.errors };
}

/** Answer one POST body: a single operation object or an array of them (operation batching). */
export function handleGraphQL(forge: Forge, payload: unknown): GqlResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { errors: [{ message: 'a GraphQL request needs a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'a GraphQL request needs a query string' }] };
    }
    const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
    let operations: GOperation[];
    try {
      operations = parseDocument(query);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'no operation in the document' }] };
    return runOperation(forge, operations[0]!, variables);
  };
  if (Array.isArray(payload)) return { status: 200, body: payload.map((entry) => runOne(entry)) };
  return { status: 200, body: runOne(payload) };
}
