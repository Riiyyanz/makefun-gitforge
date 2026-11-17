// git object model: SHA-1 object ids, tree/commit/tag parsing and building, reachability,
// and a packfile reader (OFS_DELTA/REF_DELTA included) and writer (plain objects).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GObj { type: ObjType; data: Buffer }

export const ZERO_OID = '0'.repeat(40);

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\u0000`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree: no mode separator');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree: truncated entry');
    entries.push({
      mode: data.toString('ascii', off, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    off = nul + 21;
  }
  return entries;
}

function entrySortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(entrySortKey(a), entrySortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  headers: Array<[string, string]>;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const headers: Array<[string, string]> = [];
  for (const line of data.toString('utf8', 0, headEnd).split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else headers.push([key, value]);
  }
  return { tree, parents, author, committer, message, headers };
}

export interface CommitFields {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
}

export function buildCommit(fields: CommitFields): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer ?? fields.author} ${fields.timestamp} ${tz}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTag(data: Buffer) {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const map = new Map<string, string>();
  for (const line of data.toString('utf8', 0, headEnd).split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    map.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: map.get('object') ?? '',
    type: (map.get('type') ?? 'commit') as ObjType,
    tag: map.get('tag') ?? '',
    tagger: map.get('tagger') ?? '',
    message: blank < 0 ? '' : data.toString('utf8', blank + 2),
  };
}

/** Peel a tag chain to the first non-tag object; answers the oid it lands on. */
export function peel(oid: string, get: (oid: string) => GObj | undefined): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- pack write

export function writePack(objects: readonly GObj[], level = 1): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    let size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>>= 4;
    while (size > 0) {
      bytes.push((first | 0x80) & 0xff);
      first = size & 0x7f;
      size >>>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data, { level }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (off > delta.length) throw new Error('delta: truncated size');
    }
    return value;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new Error('delta: base size mismatch');
  const out = Buffer.allocUnsafe(dstSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) { cpOff += delta[off++] * 2 ** shift; }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) { cpSize += delta[off++] * 2 ** shift; }
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      delta.copy(out, written, off, off + len);
      off += len;
      written += len;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  if (written !== dstSize) throw new Error('delta: size mismatch');
  return out;
}

export interface PackEntry { type: ObjType; oid: string; data: Buffer; delta: boolean }
export interface PackContents { version: number; count: number; objects: PackEntry[] }

/** Read a packfile, resolving deltas. `resolveBase` supplies a base a thin pack leaves out. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GObj | undefined): PackContents {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack: bad header');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  interface Raw {
    offset: number; typeCode: number; size: number; data: Buffer;
    baseOffset?: number; baseOid?: string; type?: ObjType; resolved?: Buffer; oid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = pack[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const raw: Raw = { offset: start, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      raw.baseOffset = start - value;
    } else if (typeCode === 7) {
      raw.baseOid = pack.toString('hex', off, off + 20);
      off += 20;
    }
    const inflated = inflateAt(pack, off);
    raw.data = inflated.data.subarray(0, raw.size);
    off = inflated.next;
    raws.push(raw);
    byOffset.set(start, raw);
  }
  const resolved = new Map<string, GObj>();
  const resolve = (raw: Raw, depth = 0): GObj => {
    if (raw.type !== undefined && raw.resolved !== undefined && raw.oid !== undefined) return { type: raw.type, data: raw.resolved };
    if (depth > 64) throw new Error('pack: delta chain too deep');
    let base: GObj | null = null;
    if (raw.typeCode === 6) {
      const baseRaw = byOffset.get(raw.baseOffset!);
      if (baseRaw === undefined) throw new Error('pack: ofs-delta base missing');
      base = resolve(baseRaw, depth + 1);
    } else if (raw.typeCode === 7) {
      const oid = raw.baseOid!;
      const local = resolved.get(oid);
      if (local !== undefined) base = local;
      else {
        const external = resolveBase?.(oid);
        if (external === undefined) throw new Error(`pack: ref-delta base ${oid} missing`);
        base = external;
      }
    }
    let type: ObjType;
    let data: Buffer;
    if (raw.typeCode === 1) { type = 'commit'; data = raw.data; }
    else if (raw.typeCode === 2) { type = 'tree'; data = raw.data; }
    else if (raw.typeCode === 3) { type = 'blob'; data = raw.data; }
    else if (raw.typeCode === 4) { type = 'tag'; data = raw.data; }
    else { type = base!.type; data = applyDelta(base!.data, raw.data); }
    raw.type = type;
    raw.resolved = data;
    raw.oid = hashObject(type, data);
    resolved.set(raw.oid, { type, data });
    return { type, data };
  };
  const entries: PackEntry[] = [];
  for (const raw of raws) {
    const obj = resolve(raw);
    entries.push({ type: obj.type, oid: raw.oid!, data: obj.data, delta: raw.typeCode === 6 || raw.typeCode === 7 });
  }
  return { version, count, objects: entries };
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `roots` (commits → tree + parents, trees → entries, tags → target). */
export function collectReachable(roots: Iterable<string>, get: (oid: string) => GObj | undefined, out = new Set<string>()): Set<string> {
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
