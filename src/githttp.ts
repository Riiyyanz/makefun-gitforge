// git smart HTTP: info/refs advertisements (upload-pack v0 and v2, receive-pack v0),
// v2 ls-refs and fetch, v0 fetch, and receive-pack with per-ref report-status.

import type { ServerResponse } from 'node:http';
import { DELIM, FLUSH, pkt, readPkt } from './pkt.ts';
import { ZERO_OID, isOid, parseCommit, parseTag, parseTree, peel, readPack, writePack, type GObj } from './objects.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'gitforge/1.0';
const UP_V0_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=${AGENT}`;
const RP_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
const V2_CAPS = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n'];

const TYPE_TEXT: Record<string, string> = {
  'info/refs': 'application/x-git-upload-pack-advertisement',
  'git-upload-pack': 'application/x-git-upload-pack-result',
  'git-receive-pack': 'application/x-git-receive-pack-result',
};

function repoRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].filter(([, oid]) => oid !== ZERO_OID).map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The ref HEAD resolves to, or the default branch when HEAD points at nothing. */
function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The oid HEAD names, or null on an unborn branch. */
function headOid(repo: Repo): string | null {
  return repo.refs.get(headTarget(repo)) ?? null;
}

function tagPeel(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return peel(oid, (candidate) => repo.objects.get(candidate));
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UP_V0_CAPS} symref=HEAD:${headTarget(repo)}` : RP_CAPS;
  const head = headOid(repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = repoRefs(repo);
  if (head === null && refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): Buffer => {
    const suffix = first ? `\u0000${caps}` : '';
    first = false;
    return pkt(`${oid} ${name}${suffix}\n`);
  };
  parts.push(line(head ?? ZERO_OID, 'HEAD'));
  for (const ref of refs) {
    parts.push(line(ref.oid, ref.name));
    const peeled = tagPeel(repo, ref.oid);
    if (peeled !== null) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(repo: Repo): Buffer {
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  for (const line of V2_CAPS) parts.push(pkt(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** A JSON error body for the git paths that must answer a status (a missing repository). */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

/** Split a request body into its packet lines and the raw bytes after the first flush. */
function splitAtFlush(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    const read = readPkt(body, offset);
    if (read === null) return { lines, rest: body.subarray(offset) };
    const packet = read.packet;
    if ('control' in packet) {
      if (packet.control === 0) return { lines, rest: body.subarray(read.next) };
      offset = read.next;
      continue;
    }
    lines.push(packet.data.toString('utf8'));
    offset = read.next;
  }
}

// ---------------------------------------------------------------- ls-refs

function lsRefsLines(repo: Repo, lines: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peelWanted = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const head = headOid(repo);
  if (symrefs && matches('HEAD')) {
    if (head === null) {
      if (unborn) out.push(pkt(`unborn HEAD symref-target:${headTarget(repo)}\n`));
    } else {
      out.push(pkt(`${head} HEAD symref-target:${headTarget(repo)}\n`));
    }
  }
  for (const ref of repoRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peelWanted) {
      const peeled = tagPeel(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch

interface Selection { oids: string[]; shallow: string[]; unshallow: string[] }

function addTreeClosure(repo: Repo, root: string, into: Set<string>): void {
  const stack = [root];
  while (stack.length) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    into.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    }
  }
}

/** The objects a fetch must send: reachable from the wants (depth-bounded), minus what the client holds. */
function selectObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
): Selection {
  const include = new Set<string>();
  const boundary = new Set<string>();
  const depthLimit = depth === null ? Number.POSITIVE_INFINITY : Math.max(1, depth);
  const seen = new Set<string>();
  const stack: Array<[string, number]> = wants.map((oid) => [oid, 1] as [string, number]);
  while (stack.length) {
    const [oid, d] = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    include.add(oid);
    if (obj.type === 'tag') {
      stack.push([parseTag(obj.data).object, d]);
      continue;
    }
    if (obj.type === 'tree') {
      addTreeClosure(repo, oid, include);
      continue;
    }
    if (obj.type !== 'commit') continue;
    const view = parseCommit(obj.data);
    addTreeClosure(repo, view.tree, include);
    if (d + 1 > depthLimit) {
      if (view.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of view.parents) stack.push([parent, d + 1]);
  }
  const haveSet = new Set<string>();
  const shallowSet = new Set(shallow);
  const haveStack = [...haves];
  while (haveStack.length) {
    const oid = haveStack.pop()!;
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    haveSet.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      addTreeClosure(repo, view.tree, haveSet);
      if (shallowSet.has(oid)) continue;
      for (const parent of view.parents) haveStack.push(parent);
    } else if (obj.type === 'tag') {
      haveStack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      addTreeClosure(repo, oid, haveSet);
    }
  }
  const oids: string[] = [];
  for (const oid of include) if (!haveSet.has(oid)) oids.push(oid);
  const unshallow: string[] = [];
  for (const oid of shallow) {
    if (!include.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => include.has(parent))) unshallow.push(oid);
  }
  return { oids, shallow: [...boundary], unshallow };
}

function packFor(repo: Repo, oids: readonly string[]): Buffer {
  const objects: GObj[] = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return writePack(objects);
}

function sideband(pack: Buffer, out: Buffer[]): void {
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1;
    slice.copy(framed, 1);
    out.push(pkt(framed));
  }
}

function fetchV2(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitAtFlush(body);
  const command = lines.length > 0 && lines[0]!.startsWith('command=') ? lines[0]!.slice(8).trim() : 'fetch';
  if (command === 'ls-refs') return lsRefsLines(repo, lines.slice(1));
  if (command !== 'fetch') return pktLines([]);
  const args = lines.slice(1);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'done') done = true;
    else if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  // protocol v2 separates sections with a delim-pkt and ends the whole response with a flush-pkt.
  // The acknowledgments section is sent only when the client offered haves; a clone expects the
  // packfile section alone, and an extra section makes it fail with "expected 'packfile'".
  const out: Buffer[] = [];
  if (wants.length === 0) {
    if (haves.length > 0) out.push(pkt('acknowledgments\n'), pkt('NAK\n'));
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  if (haves.length > 0) {
    // Without "done" the negotiation is still open: answer acknowledgments alone. Any further
    // section here is refused by the client ("expected no other sections to be sent after no 'ready'").
    if (!done) {
      out.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
      return Buffer.concat(out);
    }
    out.push(pkt('acknowledgments\n'), pkt('NAK\n'), DELIM);
  }
  const selection = selectObjects(repo, wants, haves, shallow, depth);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of selection.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'));
  sideband(packFor(repo, selection.oids), out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

/** A v0 upload-pack POST: the wants/haves negotiation, answered with NAK and a sideband pack. */
function fetchV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = splitAtFlush(body);
  const wants: string[] = [];
  const haves: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!.trim();
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    }
  }
  const out: Buffer[] = [pkt('NAK\n')];
  if (wants.length > 0) {
    const selection = selectObjects(repo, wants, haves, [], null);
    sideband(packFor(repo, selection.oids), out);
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = splitAtFlush(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sidebandWanted = false;
  lines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sidebandWanted = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const space = line.indexOf(' ');
    const last = line.lastIndexOf(' ');
    if (space < 0 || last <= space) return;
    const oldOid = line.slice(0, space);
    const newOid = line.slice(space + 1, last);
    const ref = line.slice(last + 1);
    if (!isOid(oldOid) || !isOid(newOid) || ref === '') return;
    commands.push({ oldOid, newOid, ref });
  });
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const contents = readPack(rest, (oid) => repo.objects.get(oid));
      for (const entry of contents.objects) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
      const missing = contents.objects.filter((entry) => !repo.objects.has(entry.oid));
      if (missing.length > 0) unpackDetail = 'missing objects';
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [`unpack ${unpackDetail}`];
  if (unpackDetail === 'ok') {
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        if (repo.refs.has(command.ref)) {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}`);
        } else {
          report.push(`ng ${command.ref} no such ref`);
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (target === undefined) {
        report.push(`ng ${command.ref} missing necessary objects`);
        continue;
      }
      const current = repo.refs.get(command.ref) ?? null;
      const commit = peel(command.newOid, (oid) => repo.objects.get(oid));
      if (commit !== command.newOid) {
        // an annotated tag object: a ref update that is not a commit only has to carry the object
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}`);
        continue;
      }
      const currentCommit = current === null ? null : peel(current, (oid) => repo.objects.get(oid));
      if (currentCommit !== null && !forge.isDescendant(repo, command.newOid, currentCommit)) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.pushedAt = forge.stamp();
      report.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  }
  const framed = Buffer.concat([...report.map((line) => pkt(`${line}\n`)), FLUSH]);
  if (!sidebandWanted) return framed;
  const out: Buffer[] = [];
  sideband(framed, out);
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- the entry point

export function handleGitHttp(
  forge: Forge,
  owner: string,
  name: string,
  suffix: string,
  url: URL,
  method: string,
  body: Buffer,
  gitProtocol: string | null,
  res: ServerResponse,
): void {
  const repo = forge.lookup(owner, name);
  if (suffix === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 403, { message: 'smart HTTP only' });
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (gitProtocol ?? '').includes('version=2');
    if (service === 'git-receive-pack') {
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', advertisementV0(repo, service));
      return;
    }
    sendGit(res, 200, TYPE_TEXT['info/refs']!, wantsV2 ? advertisementV2(repo) : advertisementV0(repo, service));
    return;
  }
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' });
    return;
  }
  if (suffix === 'git-upload-pack') {
    const v2 = (gitProtocol ?? '').includes('version=2');
    sendGit(res, 200, TYPE_TEXT['git-upload-pack']!, v2 ? fetchV2(repo, body) : fetchV0(repo, body));
    return;
  }
  sendGit(res, 200, TYPE_TEXT['git-receive-pack']!, receivePack(forge, repo, body));
}

export const GIT_SUFFIXES = ['info/refs', 'git-upload-pack', 'git-receive-pack'] as const;
