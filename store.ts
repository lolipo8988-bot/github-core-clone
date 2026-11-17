// store.ts — the forge's domain state: one user (the token owner), repositories with their git
// object stores and refs, issues, pull requests, labels and comments. Everything lives in memory;
// every timestamp comes from a deterministic clock seeded by MAKEFUN_TRIAL_NOW so two runs of the
// same trial produce byte-identical answers.

import { ObjectStore, buildCommit, parseCommit, type GitObject } from './gitcore.ts';

/** The suite's fixed scenario names the token owner adaiversen (id 1000); see SPEC.md. */
export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;

export interface User {
  readonly login: string;
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export const VIEWER: User = { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_LOGIN, email: VIEWER_EMAIL };

/** Deterministic clock: MAKEFUN_TRIAL_NOW (ISO or epoch) plus one second per tick. */
export class Clock {
  private readonly baseMs: number;
  private tick = 0;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    let parsed = Number.NaN;
    if (/^\d+$/.test(raw)) parsed = Number(raw) * (raw.length <= 10 ? 1000 : 1);
    else if (raw) parsed = Date.parse(raw);
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.UTC(2025, 0, 1);
  }

  nowDate(): Date {
    const date = new Date(this.baseMs + this.tick * 1000);
    this.tick += 1;
    return date;
  }

  nowIso(): string {
    return this.nowDate().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A git ident timestamp: `<unix> +0000`. */
  nowGitIdent(name: string, email: string): string {
    const unix = Math.floor(this.nowDate().getTime() / 1000);
    return `${name} <${email}> ${unix} +0000`;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
}

export class Repo {
  readonly store = new ObjectStore();
  /** Full ref name (refs/heads/main) -> commit/tag object id. HEAD is refs/heads/<defaultBranch>. */
  readonly refs = new Map<string, string>();
  /**
   * Bumped on every store or ref change. A git-protocol reply depends only on the store,
   * the refs and the request bytes, so (version, request) names a reply exactly; the HTTP
   * layer memoizes on it. Objects arrive via put/putKnown (the store hook), refs via
   * setRef/deleteRef.
   */
  version = 0;
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly labels = new Map<string, Label>();
  nextNumber = 1;
  description = '';
  isPrivate = false;
  createdAt: string;
  updatedAt: string;
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  defaultBranch: string;

  constructor(id: number, owner: string, name: string, defaultBranch: string, clock: Clock) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.defaultBranch = defaultBranch;
    this.createdAt = clock.nowIso();
    this.updatedAt = this.createdAt;
    this.store.onNewObject = () => {
      this.version += 1;
    };
  }

  setRef(ref: string, sha: string): void {
    this.refs.set(ref, sha);
    this.version += 1;
  }

  deleteRef(ref: string): boolean {
    const removed = this.refs.delete(ref);
    if (removed) this.version += 1;
    return removed;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headSha(): string | null {
    return this.refs.get(this.headRef()) ?? null;
  }

  /** The tree id at a ref's tip, or null when the ref is unborn/missing. */
  treeOf(ref: string): string | null {
    const sha = this.refs.get(ref);
    if (!sha) return null;
    const obj = this.store.get(sha);
    if (!obj) return null;
    if (obj.type === 'commit') return parseCommit(obj.data).tree;
    if (obj.type === 'tag') return null;
    return null;
  }

  commitOf(ref: string): string | null {
    const sha = this.refs.get(ref);
    if (!sha) return null;
    const obj = this.store.get(sha);
    return obj?.type === 'commit' ? sha : null;
  }
}

export class Forge {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, options.defaultBranch ?? 'main', this.clock);
    this.nextRepoId += 1;
    repo.description = options.description ?? '';
    repo.isPrivate = options.isPrivate ?? false;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  allocIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  /** Create a commit on `branch` whose tree is `treeSha`; parent is the branch tip (if any). */
  commitOnBranch(repo: Repo, branch: string, treeSha: string, message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.commitOf(ref);
    const ident = this.clock.nowGitIdent(VIEWER_LOGIN, VIEWER_EMAIL);
    const data = buildCommit({
      tree: treeSha,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message,
    });
    const sha = repo.store.put('commit', data);
    repo.setRef(ref, sha);
    repo.updatedAt = this.clock.nowIso();
    return sha;
  }
}

/** Line-based diff counts between two blob contents (LCS; inputs in this contest are small). */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  // LCS via dynamic programming on lines, capped to keep pathological inputs cheap.
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  const lcs = dp[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  previousSha: string | null;
}

/** Files changed between two trees (path-level, with line counts). */
export function changedFiles(store: ObjectStore, fromTree: string | null, toTree: string | null): ChangedFile[] {
  const from = fromTree ? store.flattenTree(fromTree) : new Map<string, { sha: string; mode: string }>();
  const to = toTree ? store.flattenTree(toTree) : new Map<string, { sha: string; mode: string }>();
  const out: ChangedFile[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before && after && before.sha === after.sha) continue;
    const oldText = before ? (store.get(before.sha)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (store.get(after.sha)?.data.toString('utf8') ?? '') : '';
    const counts = before && after ? diffCounts(oldText, newText) : { additions: after ? newText.split('\n').length : 0, deletions: before ? oldText.split('\n').length : 0 };
    out.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: after?.sha ?? '',
      previousSha: before?.sha ?? null,
    });
  }
  return out;
}

export interface MergeOutcome {
  ok: boolean;
  treeSha: string | null;
  conflicts: string[];
}

/** Three-way tree merge: base -> ours (current base tip) vs base -> theirs (head tip). */
export function mergeTrees(store: ObjectStore, baseTree: string | null, ourTree: string | null, theirTree: string | null): MergeOutcome {
  const base = baseTree ? store.flattenTree(baseTree) : new Map<string, { sha: string; mode: string }>();
  const ours = ourTree ? store.flattenTree(ourTree) : new Map<string, { sha: string; mode: string }>();
  const theirs = theirTree ? store.flattenTree(theirTree) : new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, { sha: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { sha: string }, y?: { sha: string }): boolean => x?.sha === y?.sha;
    if (same(o, t)) {
      if (o) result.set(path, o);
    } else if (same(b, o)) {
      if (t) result.set(path, t);
    } else if (same(b, t)) {
      if (o) result.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length) return { ok: false, treeSha: null, conflicts };
  return { ok: true, treeSha: store.buildTreeFromFiles(result), conflicts: [] };
}

export type { GitObject };
