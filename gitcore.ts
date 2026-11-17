// gitcore.ts — the git object model for the forge: SHA-1 objects, trees, commits, tags,
// packfile read (with OFS/REF delta resolution) and write (plain objects), pkt-lines and
// reachability. Node built-ins only (node:crypto, node:zlib). No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
export const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const ID_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function sha1Hex(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode every complete pkt-line in `bytes`; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const lenText = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) { out.push({ kind: 'flush' }); offset += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); offset += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); offset += 4; continue; }
    if (len < 4 || offset + len > bytes.length) throw new Error('pkt-line overruns the body');
    out.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string; // '100644' | '100755' | '120000' | '40000' (as stored, no leading zero)
  readonly name: string;
  readonly sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // git sorts tree entries bytewise, directories as if the name ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly raw: Buffer;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const out: TagView = { object: '', type: '', tag: '', tagger: '', message: split >= 0 ? text.slice(split + 2) : '' };
  const fields: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields[line.slice(0, space)] = line.slice(space + 1);
  }
  return { ...out, object: fields.object ?? '', type: fields.type ?? '', tag: fields.tag ?? '', tagger: fields.tagger ?? '' };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// object store
// ---------------------------------------------------------------------------

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  /** Called whenever an object the store did not hold is added (the Repo's cache version). */
  onNewObject: (() => void) | null = null;

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  /** Store an object's payload; returns its id. Idempotent. */
  put(type: GitObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, data });
      this.onNewObject?.();
    }
    return sha;
  }

  putKnown(sha: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, data });
      this.onNewObject?.();
    }
  }

  /** The depth-limited closure of `tips`: commits within `depth` generations of a tip (tip = 1;
   *  no depth limit when undefined), the tag objects pointing at them, and the full tree closure
   *  of every included commit. `boundary` lists the included commits that have a parent outside
   *  the set — the shallow boundary a fetch reports. */
  depthClosure(tips: readonly string[], depth?: number, stopCommits?: ReadonlySet<string>): { objects: Set<string>; commits: Set<string>; boundary: string[] } {
    const objects = new Set<string>();
    const commits = new Set<string>();
    // Resolve the tips to commits, remembering tag objects that point (transitively) at them.
    let frontier = new Set<string>();
    const tagObjects: Array<{ tagSha: string; target: string }> = [];
    const resolveTip = (sha: string): void => {
      let current = sha;
      const chain: string[] = [];
      for (;;) {
        const obj = this.objects.get(current);
        if (!obj) return;
        if (obj.type === 'tag') {
          chain.push(current);
          current = parseTag(obj.data).object;
          continue;
        }
        if (obj.type === 'commit') {
          for (const tagSha of chain) tagObjects.push({ tagSha, target: current });
          frontier.add(current);
        } else {
          objects.add(current);
        }
        return;
      }
    };
    for (const tip of tips) resolveTip(tip);
    let level = 1;
    while (frontier.size && (depth === undefined || level <= depth)) {
      const next = new Set<string>();
      for (const sha of frontier) {
        if (commits.has(sha)) continue;
        const obj = this.objects.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        commits.add(sha);
        objects.add(sha);
        const commit = parseCommit(obj.data);
        this.addTreeClosure(commit.tree, objects);
        // A stop commit (a client's declared shallow boundary) is included with its tree,
        // but the walk does not descend past it: the client does not hold its parents.
        if (stopCommits?.has(sha)) continue;
        for (const parent of commit.parents) if (!commits.has(parent)) next.add(parent);
      }
      frontier = next;
      level += 1;
    }
    for (const { tagSha, target } of tagObjects) if (commits.has(target)) objects.add(tagSha);
    const boundary: string[] = [];
    for (const sha of commits) {
      const obj = this.objects.get(sha);
      if (!obj) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !commits.has(p) && this.objects.has(p))) boundary.push(sha);
    }
    return { objects, commits, boundary };
  }

  /** Every object to send for `tips`: the depth-limited closure minus everything reachable
   *  from the `exclude` tips (the client's haves). */
  reachable(tips: readonly string[], options: { exclude?: ReadonlySet<string>; excludeStopAt?: ReadonlySet<string>; depth?: number } = {}): { objects: Set<string>; boundary: string[] } {
    const { objects, boundary } = this.depthClosure(tips, options.depth);
    if (options.exclude && options.exclude.size) {
      const excludedClosure = this.depthClosure([...options.exclude], undefined, options.excludeStopAt).objects;
      for (const sha of excludedClosure) objects.delete(sha);
    }
    return { objects, boundary };
  }

  private addTreeClosure(treeSha: string, out: Set<string>): void {
    const stack = [treeSha];
    while (stack.length) {
      const sha = stack.pop() as string;
      if (out.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'tree') continue;
      out.add(sha);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') stack.push(entry.sha);
        else out.add(entry.sha);
      }
    }
  }

  /** The set of every object reachable from the given tips (used as a have-exclusion base). */
  closure(tips: readonly string[]): Set<string> {
    return this.depthClosure(tips).objects;
  }

  /** First-parent-and-all ancestry test: is `ancestor` reachable from `descendant` (inclusive)? */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
      else if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (tag.object) stack.push(tag.object);
      }
    }
    return false;
  }

  /** A common ancestor of two commits (the merge base), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const sha = stack.pop() as string;
      if (ancestorsOfA.has(sha)) continue;
      ancestorsOfA.add(sha);
      const obj = this.objects.get(sha);
      if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsOfA.has(sha)) return sha;
      const obj = this.objects.get(sha);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (topological by ancestry walk, deduped). */
  listCommits(tip: string, limit = 100): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      out.push(sha);
      queue.push(...parseCommit(obj.data).parents);
    }
    return out;
  }

  /** Flatten a tree into path -> {sha, mode}; directories are recursed, not listed. */
  flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
    const obj = this.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') this.flattenTree(entry.sha, path, out);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) nested trees from a flat path -> {sha, mode} map; returns the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { sha: string; mode: string }>): string {
    interface Dir { files: Map<string, { sha: string; mode: string }>; dirs: Map<string, Dir>; }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.dirs.get(part);
        if (!next) { next = { files: new Map(), dirs: new Map() }; dir.dirs.set(part, next); }
        dir = next;
      }
      dir.files.set(parts[parts.length - 1] as string, file);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, sha: file.sha });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
      return this.put('tree', buildTree(entries));
    };
    if (files.size === 0) return this.put('tree', Buffer.alloc(0));
    return build(root);
  }

  /** Read one tree level (for the contents API directory listing). */
  treeEntries(treeSha: string): TreeEntry[] {
    const obj = this.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.data);
  }

  /** Resolve a path inside a tree to its entry, walking directories. */
  lookupPath(treeSha: string, path: string): { sha: string; mode: string; type: 'blob' | 'tree' } | null {
    const parts = path.split('/').filter((p) => p.length > 0);
    let current = treeSha;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        return entry.mode === '40000' ? { sha: entry.sha, mode: entry.mode, type: 'tree' } : { sha: entry.sha, mode: entry.mode, type: 'blob' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.sha;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

interface InflateInfoResult {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

/** Inflate the deflate stream starting at `offset`; returns the data and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // One inflate of the remaining bytes: zlib stops at the stream's end and ignores the rest,
  // and the engine's bytesWritten is exactly the compressed length it consumed. This replaces
  // a binary search that re-inflated the same object a dozen times per pack object.
  const rest = buffer.subarray(offset);
  try {
    const result = (inflateSync as unknown as (data: Buffer, options: { info: true }) => InflateInfoResult)(rest, { info: true });
    const consumed = result.engine.bytesWritten;
    if (Number.isSafeInteger(consumed) && consumed > 0 && consumed <= rest.length) {
      return { data: result.buffer, next: offset + consumed };
    }
  } catch {
    // A truncated or corrupt stream throws here as it did before; the search below re-finds
    // the failure on its own terms (and throws the same way) for any input this path rejects.
  }
  return inflateAtBySearch(buffer, offset);
}

/** The original search-based inflate: the shortest prefix of the stream that inflates fully. */
function inflateAtBySearch(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // zlib streams are self-terminating and no proper prefix of one inflates, so binary-search the
  // shortest slice that inflates to the full output.
  const rest = buffer.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  let full: Buffer | null = null;
  // First find an upper bound that inflates at all.
  let probe = Math.min(rest.length, 64);
  for (;;) {
    try {
      full = inflateSync(rest.subarray(0, probe));
      hi = probe;
      break;
    } catch {
      if (probe >= rest.length) throw new Error('pack object does not inflate');
      probe = Math.min(rest.length, probe * 4);
    }
  }
  lo = Math.max(1, Math.floor(probe / 4));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const data = inflateSync(rest.subarray(0, mid));
      if (data.equals(full)) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: full, next: offset + lo };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { cpOffset += (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x04) { cpOffset += (delta[offset] as number) << 16; offset += 1; }
      if (op & 0x08) { cpOffset += (delta[offset] as number) << 24; offset += 1; }
      if (op & 0x10) { cpSize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { cpSize += (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x40) { cpSize += (delta[offset] as number) << 16; offset += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  sha: string;
}

/** Read a whole pack into the store. `external` resolves REF_DELTA bases the pack does not carry
 *  (thin packs); bases the store already holds are used first. Returns the object ids added. */
export function readPackInto(store: ObjectStore, pack: Buffer, external?: (sha: string) => GitObject | undefined): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let offset = 12;
  const byOffset = new Map<number, PackEntry>();
  const added: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const objectOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: a negative offset to the base object's start.
      let b = pack[offset] as number;
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const baseStart = objectOffset - baseOffset;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      // Bases always precede their deltas in a pack, so the base is already resolved.
      const base = byOffset.get(baseStart);
      if (!base) throw new Error('ofs-delta base not in pack');
      const data = applyDelta(base.data, inflated.data);
      const entry: PackEntry = { type: base.type, data, sha: hashObject(base.type, data) };
      byOffset.set(objectOffset, entry);
      store.putKnown(entry.sha, entry.type, entry.data);
      added.push(entry.sha);
      void size;
    } else if (typeId === 7) {
      // REF_DELTA: the base object's id, which may live outside the pack (thin pack).
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      const deltaData = inflated.data;
      const base = store.get(baseSha) ?? external?.(baseSha);
      if (!base) throw new Error(`ref-delta base ${baseSha} is not available`);
      const data = applyDelta(base.data, deltaData);
      const entry: PackEntry = { type: base.type, data, sha: hashObject(base.type, data) };
      byOffset.set(objectOffset, entry);
      store.putKnown(entry.sha, entry.type, entry.data);
      added.push(entry.sha);
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`bad pack object type ${typeId}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      const entry: PackEntry = { type, data: inflated.data, sha: hashObject(type, inflated.data) };
      byOffset.set(objectOffset, entry);
      store.putKnown(entry.sha, entry.type, entry.data);
      added.push(entry.sha);
    }
  }
  return added;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a pack of plain (non-delta) objects with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
