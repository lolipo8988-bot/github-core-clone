// githttp.ts — git smart HTTP: info/refs advertisements (v2 for upload-pack when asked, v0
// otherwise and for receive-pack), protocol v2 ls-refs and fetch, protocol v0 fetch, and
// receive-pack pushes with per-ref report-status. No git binary: the pack protocol is spoken
// directly against the repo's ObjectStore.

import {
  ObjectStore, PKT_DELIM, PKT_FLUSH, ZERO_OID, decodePktLines, encodePktLine, parseTag,
  readPackInto, writePack, type GitObject,
} from './gitcore.ts';
import { Forge, Repo, VIEWER } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/{DEFAULT} agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function pkt(payload: string | Buffer): Buffer {
  return encodePktLine(payload);
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Ref lines for a v0 advertisement or ls-refs: HEAD first, then refs in order, tags peeled. */
function refLines(repo: Repo, options: { caps?: string } = {}): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = repo.headRef();
  const headSha = repo.refs.get(headRef);
  const caps = options.caps !== undefined ? `\0${options.caps.replace('{DEFAULT}', repo.defaultBranch)}` : '';
  if (headSha) {
    lines.push(pkt(`${headSha} HEAD${caps}\n`));
  } else {
    lines.push(pkt(`${ZERO_OID} capabilities^{}${caps}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    lines.push(pkt(`${sha} ${ref}\n`));
    const obj = repo.store.get(sha);
    if (obj?.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target) lines.push(pkt(`${target} ${ref}^{}\n`));
    }
  }
  return lines;
}

export function infoRefs(forge: Forge, owner: string, name: string, service: string, protocolVersion: string | null): GitReply {
  const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
  if (!repo) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown service\n') };
  }
  if (service === 'git-upload-pack' && protocolVersion === 'version=2') {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=forge/1.0\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const preamble = pkt(`# service=${service}\n`);
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const body = Buffer.concat([preamble, PKT_FLUSH, ...refLines(repo, { caps }), PKT_FLUSH]);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headRef = repo.headRef();
  const headSha = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headSha) {
      let line = `${headSha} HEAD`;
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(pkt(`${line}\n`));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(pkt(`${line}\n`));
    }
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    const obj = repo.store.get(sha);
    if (args.peel && obj?.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target) line += ` peeled:${target}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function computeFetch(store: ObjectStore, args: FetchArgs): { pack: Buffer | null; shallowInfo: string[]; unshallow: string[]; nothingNew: boolean } {
  const haveSet = new Set(args.haves.filter((h) => store.has(h)));
  const { objects, boundary } = store.reachable(args.wants, {
    exclude: haveSet,
    excludeStopAt: new Set(args.shallow),
    depth: args.deepen ?? undefined,
  });
  const nothingNew = objects.size === 0;
  const shallowInfo: string[] = [];
  const unshallow: string[] = [];
  if (args.deepen !== null || args.shallow.length) {
    for (const sha of boundary) shallowInfo.push(sha);
    // A commit the client already held shallow stops being shallow when its parents are now sent.
    for (const sha of args.shallow) {
      if (!boundary.includes(sha) && store.has(sha)) unshallow.push(sha);
    }
  }
  if (nothingNew) return { pack: null, shallowInfo, unshallow, nothingNew };
  const packObjects: GitObject[] = [];
  for (const sha of objects) {
    const obj = store.get(sha);
    if (obj) packObjects.push(obj);
  }
  return { pack: writePack(packObjects), shallowInfo, unshallow, nothingNew };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const result = computeFetch(repo.store, args);
  if (args.haves.length) {
    const lines: Buffer[] = [pkt('acknowledgments\n')];
    if (result.nothingNew) {
      for (const have of args.haves) if (repo.store.has(have)) lines.push(pkt(`ACK ${have}\n`));
      lines.push(pkt('ready\n'));
    } else {
      lines.push(pkt('NAK\n'));
    }
    lines.push(PKT_DELIM);
    parts.push(...lines);
  }
  if (args.deepen !== null || args.shallow.length) {
    const lines: Buffer[] = [pkt('shallow-info\n')];
    for (const sha of result.shallowInfo) lines.push(pkt(`shallow ${sha}\n`));
    for (const sha of result.unshallow) lines.push(pkt(`unshallow ${sha}\n`));
    lines.push(PKT_DELIM);
    parts.push(...lines);
  }
  if (result.pack) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPackets(result.pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const result = computeFetch(repo.store, args);
  const parts: Buffer[] = [];
  for (const sha of result.shallowInfo) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of result.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt('NAK\n'));
  if (result.pack) parts.push(...sidebandPackets(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// POST handlers
// ---------------------------------------------------------------------------

export function uploadPack(forge: Forge, owner: string, name: string, body: Buffer, protocolVersion: string | null): GitReply {
  const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
  if (!repo) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
  try {
    const packets = decodePktLines(body);
    const firstData = packets.find((p) => p.kind === 'data');
    const firstLine = firstData?.kind === 'data' ? firstData.payload.toString('utf8') : '';
    if (protocolVersion === 'version=2' || firstLine.startsWith('command=')) {
      return handleV2(repo, packets);
    }
    return handleV0Fetch(repo, packets);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('malformed request\n') };
  }
}

function handleV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitReply {
  // Split at the delim packet: capability lines before, argument lines after (to flush).
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const head = delimIndex >= 0 ? packets.slice(0, delimIndex) : packets;
  const tail = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
  let command = '';
  for (const packet of head) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
  }
  const argLines: string[] = [];
  for (const packet of tail) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
  }
  if (command === 'fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
    for (const line of argLines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
      else if (line === 'done') args.done = true;
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, args) };
  }
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown command\n') };
}

function handleV0Fetch(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitReply {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let section: 'want' | 'have' = 'want';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (section === 'want') section = 'have';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, args) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, owner: string, name: string, body: Buffer): GitReply {
  const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
  if (!repo) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
  try {
    // Parse the command list: pkt-lines up to the flush packet; the rest is the packfile.
    let offset = 0;
    const commands: PushCommand[] = [];
    let sideband = false;
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
      const len = parseInt(lenText, 16);
      if (len === 0) {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (len < 4 || offset + len > body.length) throw new Error('bad command pkt-line');
      let payload = body.subarray(offset + 4, offset + len).toString('utf8');
      offset += len;
      if (commands.length === 0) {
        const nul = payload.indexOf('\0');
        if (nul >= 0) {
          const caps = payload.slice(nul + 1);
          sideband = caps.includes('side-band-64k');
          payload = payload.slice(0, nul);
        }
      }
      const line = payload.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length === 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
    }
    const pack = sawFlush ? body.subarray(offset) : Buffer.alloc(0);
    let unpackOk = true;
    if (pack.length > 0) {
      try {
        readPackInto(repo.store, pack);
      } catch {
        unpackOk = false;
      }
    }

    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
    if (unpackOk) {
      for (const command of commands) {
        reportLines.push(applyPushCommand(repo, command));
      }
    } else {
      for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
    }

    const inner = Buffer.concat([...reportLines.map((l) => pkt(l)), PKT_FLUSH]);
    let responseBody: Buffer;
    if (sideband) {
      const chunks: Buffer[] = [];
      const CHUNK = 65516 - 1;
      for (let i = 0; i < inner.length; i += CHUNK) {
        chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(inner.length, i + CHUNK))])));
      }
      chunks.push(PKT_FLUSH);
      responseBody = Buffer.concat(chunks);
    } else {
      responseBody = inner;
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('malformed request\n') };
  }
}

function applyPushCommand(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete.
    if (!repo.refs.has(ref)) return `ng ${ref} reference does not exist\n`;
    repo.refs.delete(ref);
    return `ok ${ref}\n`;
  }
  const target = repo.store.get(newOid);
  if (!target) return `ng ${ref} unknown object\n`;
  if (oldOid === ZERO_OID) {
    if (repo.refs.has(ref)) return `ng ${ref} already exists\n`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}\n`;
  }
  if (current !== oldOid) return `ng ${ref} stale info\n`;
  // Fast-forward only: the old tip must be an ancestor of the new one (tags may point at tags).
  if (target.type === 'commit' || target.type === 'tag') {
    if (!repo.store.isAncestor(oldOid, newOid)) return `ng ${ref} non-fast-forward\n`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}\n`;
}
