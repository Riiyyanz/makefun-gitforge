// The forge's store: repositories, git objects, refs, issues, labels, comments and pull requests.
// Everything is in memory; nothing is written to disk (no fsync in the hot path).

import {
  ZERO_OID, buildCommit, buildTree, collectReachable, hashObject, isOid, parseCommit, parseTree,
  peel, type GObj, type ObjType, type TreeEntry,
} from './objects.ts';

export interface Label { id: number; name: string; color: string; description: string | null }

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number[];
}

export interface Comment { id: number; body: string; createdAt: string; issueNumber: number }

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GObj>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssue: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment>;
  nextComment: number;
  pulls: Map<number, Pull>;
  nextPull: number;
}

const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the fixed base every generated stamp counts from

/** The one store every surface writes to (REST, GraphQL, MCP and the git wire). */
export class Forge {
  /** The login the bearer token names; learned from the first request that names it (see adopt()). */
  login: string | null = null;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextIssueId = 100000;
  private nextCommentId = 500000;
  private nextPullId = 700000;
  private nextLabelId = 900000;
  private stampCounter = 0;

  /** A deterministic timestamp for a created or updated object: the fixed epoch plus a counter. */
  stamp(): string {
    this.stampCounter += 1;
    return new Date((EPOCH_SEC + this.stampCounter) * 1000).toISOString();
  }

  /** Learn the token's login from the first owner a request names for a repository it owns. */
  adopt(owner: string): void {
    if (this.login !== null || owner === '') return;
    this.login = owner;
    for (const repo of this.repos.values()) if (repo.owner === '') repo.owner = owner;
  }

  get viewer(): string {
    return this.login ?? 'gitforge';
  }

  /** The repository at `owner/name`, or null: a repository belongs to the token's login alone. */
  lookup(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.login === null) {
      this.adopt(owner);
      return repo;
    }
    return owner === this.login ? repo : null;
  }

  /** The same lookup without any ownership question (an internal caller that already resolved it). */
  byName(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const stamp = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.login ?? '',
      name,
      private: options.private === true,
      description: options.description ?? '',
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      pushedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssue: 1,
      labels: new Map(),
      comments: new Map(),
      nextComment: 1,
      pulls: new Map(),
      nextPull: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  /** An id in the range a fresh store hands out (used for ids GitHub keeps per object type). */
  nextIssueIdValue(): number { return this.nextIssueId++; }
  nextCommentIdValue(): number { return this.nextCommentId++; }
  nextPullIdValue(): number { return this.nextPullId++; }
  nextLabelIdValue(): number { return this.nextLabelId++; }

  // ---------------------------------------------------------------- git helpers

  getObject(repo: Repo, oid: string): GObj | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tree of a commit oid, or null. */
  treeOf(repo: Repo, commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Set (or delete, with blobOid null) one path in a tree, returning the new root tree oid. */
  writeTreePath(repo: Repo, baseTree: string | null, segments: readonly string[], blobOid: string | null, mode = '100644'): string {
    const base: TreeEntry[] = baseTree === null ? [] : parseTree(repo.objects.get(baseTree)!.data);
    const [head, ...rest] = segments;
    const others = base.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) others.push({ mode, name: head, oid: blobOid });
      return this.putObject(repo, 'tree', buildTree(others));
    }
    const existing = base.find((entry) => entry.name === head);
    const childBase = existing !== undefined && (existing.mode === '40000' || existing.mode === '040000') ? existing.oid : null;
    const childTree = this.writeTreePath(repo, childBase, rest, blobOid, mode);
    others.push({ mode: '40000', name: head, oid: childTree });
    return this.putObject(repo, 'tree', buildTree(others));
  }

  /** Look a path up in a commit's tree: a blob oid, a directory marker, or null. */
  treePath(repo: Repo, commitOid: string | null, segments: readonly string[]): { oid: string; type: 'blob' | 'tree' } | null {
    let tree = this.treeOf(repo, commitOid);
    if (tree === null) return null;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = parseTree(repo.objects.get(tree)!.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      const last = i === segments.length - 1;
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      if (last) return { oid: entry.oid, type: isDir ? 'tree' : 'blob' };
      if (!isDir) return null;
      tree = entry.oid;
    }
    return { oid: tree, type: 'tree' };
  }

  /** Create a commit on top of `parentOid` whose tree takes `changes` (path → blob oid, null deletes). */
  commitChanges(
    repo: Repo,
    parentOid: string | null,
    changes: ReadonlyArray<{ path: string; blobOid: string | null }>,
    message: string,
  ): string {
    let tree = this.treeOf(repo, parentOid);
    for (const change of changes) {
      const segments = change.path.split('/').filter((part) => part !== '');
      tree = this.writeTreePath(repo, tree, segments, change.blobOid);
    }
    const stamp = this.stamp();
    const when = Math.floor(Date.parse(stamp) / 1000);
    const data = buildCommit({
      tree: tree!,
      parents: parentOid === null ? [] : [parentOid],
      message: message === '' ? 'commit' : message,
      author: `${this.viewer} <${this.viewer}@example.invalid>`,
      timestamp: when,
    });
    const oid = this.putObject(repo, 'commit', data);
    return oid;
  }

  /** The commits reachable from `startOid`, newest first, up to `limit`. */
  commitLog(repo: Repo, startOid: string | null, limit = 100): Array<{ oid: string; view: ReturnType<typeof parseCommit> }> {
    const out: Array<{ oid: string; view: ReturnType<typeof parseCommit> }> = [];
    let current = startOid;
    const seen = new Set<string>();
    while (current !== null && out.length < limit && !seen.has(current)) {
      seen.add(current);
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') break;
      const view = parseCommit(obj.data);
      out.push({ oid: current, view });
      current = view.parents[0] ?? null;
    }
    return out;
  }

  /** The merge base of two commits (best effort, bounded). */
  mergeBase(repo: Repo, a: string | null, b: string | null): string | null {
    if (a === null || b === null) return null;
    const ancestors = collectReachable([a], (oid) => repo.objects.get(oid));
    let current = b;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      if (ancestors.has(current)) return current;
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') return null;
      current = parseCommit(obj.data).parents[0] ?? null;
    }
    return null;
  }

  /** Whether `descendant` is `ancestor` or builds on it. */
  isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
    if (descendant === ancestor) return true;
    let current: string | null = descendant;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') return false;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
      }
      current = parseCommit(obj.data).parents[0] ?? null;
    }
    return false;
  }

  /** Peel an oid to a commit. */
  peelToCommit(repo: Repo, oid: string): string | null {
    const target = peel(oid, (candidate) => repo.objects.get(candidate));
    const obj = repo.objects.get(target);
    return obj !== undefined && obj.type === 'commit' ? target : null;
  }
}

/** A flattened diff between two trees: path → status and change counts. */
export interface FileChange { path: string; status: 'added' | 'removed' | 'modified' | 'renamed'; additions: number; deletions: number }

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  return count;
}

/** The diff driver bound to one repository. */
export class RepoDiff {
  private readonly forge: Forge;
  private readonly repo: Repo;

  constructor(forge: Forge, repo: Repo) {
    this.forge = forge;
    this.repo = repo;
  }

  diff(treeA: string | null, treeB: string | null): FileChange[] {
    const changes: FileChange[] = [];
    const walk = (a: string | null, b: string | null, prefix: string): void => {
      const mapA = new Map<string, TreeEntry>();
      const mapB = new Map<string, TreeEntry>();
      if (a !== null) for (const entry of parseTree(this.forge.getObject(this.repo, a)!.data)) mapA.set(entry.name, entry);
      if (b !== null) for (const entry of parseTree(this.forge.getObject(this.repo, b)!.data)) mapB.set(entry.name, entry);
      const names = new Set([...mapA.keys(), ...mapB.keys()]);
      for (const name of names) {
        const left = mapA.get(name);
        const right = mapB.get(name);
        const path = prefix === '' ? name : `${prefix}/${name}`;
        const leftDir = left !== undefined && (left.mode === '40000' || left.mode === '040000');
        const rightDir = right !== undefined && (right.mode === '40000' || right.mode === '040000');
        if (leftDir || rightDir) {
          walk(leftDir ? left!.oid : null, rightDir ? right!.oid : null, path);
          continue;
        }
        if (left === undefined && right !== undefined) {
          const blob = this.forge.getObject(this.repo, right.oid);
          changes.push({ path, status: 'added', additions: blob === undefined ? 0 : lineCount(blob.data), deletions: 0 });
        } else if (left !== undefined && right === undefined) {
          const blob = this.forge.getObject(this.repo, left.oid);
          changes.push({ path, status: 'removed', additions: 0, deletions: blob === undefined ? 0 : lineCount(blob.data) });
        } else if (left !== undefined && right !== undefined && left.oid !== right.oid) {
          const before = this.forge.getObject(this.repo, left.oid);
          const after = this.forge.getObject(this.repo, right.oid);
          changes.push({
            path,
            status: 'modified',
            additions: after === undefined ? 0 : lineCount(after.data),
            deletions: before === undefined ? 0 : lineCount(before.data),
          });
        }
      }
    };
    walk(treeA, treeB, '');
    changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return changes;
  }

  /** Apply one side's changes onto another tree: a blob oid per path, null to delete. */
  changesOf(baseTree: string | null, headTree: string | null): Array<{ path: string; blobOid: string | null }> {
    return this.diff(baseTree, headTree).map((change) => {
      if (change.status === 'removed') return { path: change.path, blobOid: null };
      const found = this.findInTree(headTree, change.path.split('/'));
      return { path: change.path, blobOid: found };
    });
  }

  findInTree(tree: string | null, segments: readonly string[]): string | null {
    if (tree === null) return null;
    let current = tree;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = this.forge.getObject(this.repo, current);
      if (obj === undefined) return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      current = entry.oid;
    }
    return current;
  }
}

export { ZERO_OID, isOid };

// ---------------------------------------------------------------- shared write paths

export type CreatePullResult = { ok: true; pull: Pull } | { ok: false; message: string };

/** Create one pull request (REST, GraphQL and MCP all go through this). */
export function createPullRequest(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): CreatePullResult {
  const strip = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
  const head = strip(input.head);
  const base = strip(input.base === '' ? repo.defaultBranch : input.base);
  if (repo.refs.get(`refs/heads/${head}`) === undefined) return { ok: false, message: `the head branch ${head} does not exist` };
  if (repo.refs.get(`refs/heads/${base}`) === undefined) return { ok: false, message: `the base branch ${base} does not exist` };
  if (head === base) return { ok: false, message: 'head and base name the same branch' };
  const stamp = forge.stamp();
  const pull: Pull = {
    id: forge.nextPullIdValue(),
    number: repo.nextPull++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.pulls.set(pull.number, pull);
  return { ok: true, pull };
}

export type MergePullResult = { ok: true; sha: string } | { ok: false; status: 405 | 409; message: string };

/** Squash-merge one pull request onto its base branch, refusing a conflicted update. */
export function mergePullRequest(forge: Forge, repo: Repo, pull: Pull): MergePullResult {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull Request is not mergeable: it is already merged' };
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return { ok: false, status: 405, message: 'Pull Request is not mergeable: a branch is missing' };
  const mergeBase = forge.mergeBase(repo, baseTip, headTip);
  const diff = new RepoDiff(forge, repo);
  const baseTree = forge.treeOf(repo, mergeBase);
  const headTree = forge.treeOf(repo, headTip);
  if (mergeBase !== baseTip) {
    const baseChanges = new Set(diff.diff(baseTree, forge.treeOf(repo, baseTip)).map((file) => file.path));
    const conflicts = diff.diff(baseTree, headTree).filter((file) => baseChanges.has(file.path));
    if (conflicts.length > 0) {
      return { ok: false, status: 405, message: `Pull Request is not mergeable: ${conflicts[0]!.path} conflicts with the base branch` };
    }
  }
  const sha = forge.commitChanges(repo, baseTip, diff.changesOf(baseTree, headTree), `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = forge.stamp();
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}

/** The pull request's changed files, against its merge base. */
export function pullFiles(forge: Forge, repo: Repo, pull: Pull): FileChange[] {
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (headTip === null) return [];
  const diff = new RepoDiff(forge, repo);
  const files = diff.diff(forge.treeOf(repo, baseTip), forge.treeOf(repo, headTip));
  if (process.env.GITFORGE_DEBUG === '1') {
    process.stderr.write(`[pullFiles] #${pull.number} head=${pull.head}(${headTip}) base=${pull.base}(${baseTip}) files=${files.map((f) => f.path).join(',')}\n`);
  }
  // Two-dot diff against the base branch's tip: the paths the pull request changes. Falling back to
  // the merge base alone hides the file whenever the merge base already equals the head.
  return files;
}

/** The paths that differ between two trees of one repository. */
export function diffTreePaths(forge: Forge, repo: Repo, base: string | null, head: string | null): string[] {
  const diff = new RepoDiff(forge, repo);
  return diff.diff(forge.treeOf(repo, base), forge.treeOf(repo, head)).map((file) => file.path);
}
