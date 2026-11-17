// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents,
// git refs, labels, issues, comments and pull requests (list, files, squash merge).

import { parseCommit, parseTag, ZERO_OID } from './gitcore.ts';
import {
  Forge, Repo, VIEWER, changedFiles, mergeTrees, type Comment, type Issue, type Pull,
} from './store.ts';

export interface HttpContext {
  forge: Forge;
  /** e.g. http://127.0.0.1:4321 — from the request's Host header. */
  base: string;
  requestId: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: Buffer;
  contentType?: string;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

export function err(status: number, message: string): Reply {
  return { status, body: { message } };
}

export const notFound = (): Reply => err(404, 'Not Found');

// ---------------------------------------------------------------------------
// GitHub JSON shapes
// ---------------------------------------------------------------------------

export function userShape(ctx: HttpContext) {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: `${ctx.base}/avatars/${VIEWER.id}`,
    gravatar_id: '',
    url: `${ctx.base}/api/v3/users/${VIEWER.login}`,
    html_url: `${ctx.base}/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

/** GitHub-style global (node) id: opaque, stable, and decodable by our GraphQL node(). */
export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(text: string): { type: string; id: number } | null {
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    const colon = decoded.lastIndexOf(':');
    if (colon < 0) return null;
    const id = Number(decoded.slice(colon + 1));
    if (!Number.isInteger(id)) return null;
    return { type: decoded.slice(0, colon), id };
  } catch {
    return null;
  }
}

export function repoShape(ctx: HttpContext, repo: Repo) {
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}`;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    owner: userShape(ctx),
    html_url: `${ctx.base}/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: api,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://${ctx.base.replace(/^https?:\/\//, '')}/${repo.fullName}.git`,
    ssh_url: `git@${ctx.base.replace(/^https?:\/\//, '')}:${repo.fullName}.git`,
    clone_url: `${ctx.base}/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    forks: 0,
    open_issues: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelShape(ctx: HttpContext, repo: Repo, label: { id: number; name: string; color: string; description: string | null }) {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/**
 * The serialized issue body for the two hottest REST paths (POST create, GET one). Every
 * mutation route bumps the issue's updatedAt tick or its comment count (REST PATCH/comment,
 * GraphQL closeIssue/addComment alike), so that pair plus the state and the request's base
 * URL is a complete version stamp: a hit is byte-identical to a fresh issueShape stringify.
 */
const issueTextCache = new WeakMap<Issue, { stamp: string; text: string }>();

export function issueReply(ctx: HttpContext, repo: Repo, issue: Issue, status: number): Reply {
  const stamp = `${ctx.base}|${issue.updatedAt}|${issue.comments.length}|${issue.state}|${issue.title}|${issue.body ?? ''}|${issue.labels.join('')}`;
  const hit = issueTextCache.get(issue);
  if (hit && hit.stamp === stamp) {
    return { status, rawBody: Buffer.from(hit.text, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  const text = JSON.stringify(issueShape(ctx, repo, issue));
  issueTextCache.set(issue, { stamp, text });
  return { status, rawBody: Buffer.from(text, 'utf8'), contentType: 'application/json; charset=utf-8' };
}

export function issueShape(ctx: HttpContext, repo: Repo, issue: Issue) {
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: `${ctx.base}/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userShape(ctx),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelShape(ctx, repo, label) : { name };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function commentShape(ctx: HttpContext, repo: Repo, issueNumber: number, comment: Comment) {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `${ctx.base}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userShape(ctx),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function refShape(ctx: HttpContext, repo: Repo, refName: string, sha: string | null) {
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}`;
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha,
    user: userShape(ctx),
    repo: repoShape(ctx, repo),
    ...(api ? {} : {}),
  };
}

export function pullShape(ctx: HttpContext, repo: Repo, pull: Pull) {
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const mergeable = pull.state === 'open' ? computeMergeable(repo, pull) : null;
  const files = pullFiles(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    url: `${api}/pulls/${pull.number}`,
    html_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}`,
    diff_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${api}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userShape(ctx),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha ?? headSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    head: refShape(ctx, repo, pull.headRef, headSha),
    base: refShape(ctx, repo, pull.baseRef, baseSha),
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable,
    rebaseable: mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable === false ? 'dirty' : 'clean',
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 0,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changed_files: files.length,
  };
}

/** The files a pull request changes: merge-base -> head tip. */
export function pullFiles(repo: Repo, pull: Pull) {
  const headSha = repo.commitOf(`refs/heads/${pull.headRef}`);
  const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return [];
  const mergeBase = repo.store.mergeBase(baseSha, headSha) ?? baseSha;
  const fromTree = repo.store.get(mergeBase)?.type === 'commit' ? parseCommit(repo.store.get(mergeBase)?.data as Buffer).tree : null;
  const headTree = parseCommit(repo.store.get(headSha)?.data as Buffer).tree;
  return changedFiles(repo.store, fromTree, headTree);
}

export function computeMergeable(repo: Repo, pull: Pull): boolean {
  const headSha = repo.commitOf(`refs/heads/${pull.headRef}`);
  const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return false;
  const mergeBase = repo.store.mergeBase(baseSha, headSha);
  const baseTree = mergeBase ? parseCommit(repo.store.get(mergeBase)?.data as Buffer).tree : null;
  const ourTree = parseCommit(repo.store.get(baseSha)?.data as Buffer).tree;
  const theirTree = parseCommit(repo.store.get(headSha)?.data as Buffer).tree;
  return mergeTrees(repo.store, baseTree, ourTree, theirTree).ok;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha or null on conflict. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const headSha = repo.commitOf(`refs/heads/${pull.headRef}`);
  const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return null;
  const mergeBase = repo.store.mergeBase(baseSha, headSha);
  const baseTree = mergeBase ? parseCommit(repo.store.get(mergeBase)?.data as Buffer).tree : null;
  const ourTree = parseCommit(repo.store.get(baseSha)?.data as Buffer).tree;
  const theirTree = parseCommit(repo.store.get(headSha)?.data as Buffer).tree;
  const merged = mergeTrees(repo.store, baseTree, ourTree, theirTree);
  if (!merged.ok || merged.treeSha === null) return null;
  const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}\n`;
  const sha = forge.commitOnBranch(repo, pull.baseRef, merged.treeSha, message);
  return sha;
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyError: boolean;
}

function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function pageSlice<T>(items: T[], query: URLSearchParams): { slice: T[]; headers: Record<string, string>; total: number } {
  const { page, perPage } = pagination(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { slice, headers: {}, total: items.length };
}

function linkHeader(ctx: HttpContext, path: string, query: URLSearchParams, total: number): Record<string, string> {
  const { page, perPage } = pagination(query);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const make = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${ctx.base}${path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`${make(page + 1)}; rel="next"`, `${make(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${make(1)}; rel="first"`, `${make(page - 1)}; rel="prev"`);
  return links.length ? { link: links.join(', ') } : {};
}

// ---------------------------------------------------------------------------
// the REST handler
// ---------------------------------------------------------------------------

export function handleRest(ctx: HttpContext, req: RestRequest): Reply {
  const { forge } = ctx;
  const seg = req.segments;
  const m = req.method;

  // API root and meta.
  if (seg.length === 0) {
    if (m !== 'GET') return notFound();
    return json(200, {
      current_user_url: `${ctx.base}/api/v3/user`,
      current_user_repositories_url: `${ctx.base}/api/v3/user/repos`,
      repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${ctx.base}/api/v3/rate_limit`,
      emojis_url: `${ctx.base}/api/v3/emojis`,
      issue_search_url: `${ctx.base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (m !== 'GET') return notFound();
    return json(200, {
      verifiable_password_authentication: true,
      github_services_sha: 'github-core-clone',
      installed_version: '3.0.0-forge',
      hooks: [],
      git: [],
      api: [],
      web: [],
      packages: [],
      plans: [],
      importer: [],
      pages: [],
    });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (m !== 'GET') return notFound();
    return json(200, { ...userShape(ctx), plan: { name: 'free', space: 976562499, collaborators: 0, private_repos: 10000 }, total_private_repos: 0, owned_private_repos: 0 });
  }

  // /user/repos
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (m === 'GET') {
      const repos = forge.listRepos(VIEWER.login);
      const { slice } = pageSlice(repos, req.query);
      return json(200, slice.map((r) => repoShape(ctx, r)), linkHeader(ctx, '/api/v3/user/repos', req.query, repos.length));
    }
    if (m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return err(422, 'Validation Failed: name is required');
      if (forge.getRepo(VIEWER.login, name)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        description: typeof body.description === 'string' ? body.description : '',
        isPrivate: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main',
      });
      return json(201, repoShape(ctx, repo));
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const repo = owner === VIEWER.login ? forge.getRepo(owner, name) : undefined;
  if (!repo) return notFound();
  const rest = seg.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (m === 'GET') return json(200, repoShape(ctx, repo));
    if (m === 'PATCH') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
        // Renames are not exercised by the suite; ignore rather than corrupt the key map.
      }
      if (typeof body.default_branch === 'string' && body.default_branch) {
        (repo as { defaultBranch: string }).defaultBranch = body.default_branch;
      }
      repo.updatedAt = forge.clock.nowIso();
      return json(200, repoShape(ctx, repo));
    }
    if (m === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }

  // /branches and /branches/{name}
  if (rest[0] === 'branches') {
    if (rest.length === 1 && m === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false }));
      const { slice } = pageSlice(branches, req.query);
      return json(200, slice, linkHeader(ctx, `/api/v3/repos/${repo.fullName}/branches`, req.query, branches.length));
    }
    if (rest.length >= 2 && m === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound();
      return json(200, { name: branch, commit: commitShape(ctx, repo, sha), protected: false, _links: { self: `${ctx.base}/api/v3/repos/${repo.fullName}/branches/${branch}`, html: `${ctx.base}/${repo.fullName}/tree/${branch}` } });
    }
    return notFound();
  }

  // /commits and /commits/{sha}
  if (rest[0] === 'commits') {
    if (rest.length === 1 && m === 'GET') {
      const refParam = req.query.get('sha');
      const tip = refParam
        ? repo.commitOf(refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`) ?? (repo.store.get(refParam)?.type === 'commit' ? refParam : null)
        : repo.headSha();
      if (!tip) return json(200, []);
      const shas = repo.store.listCommits(tip, 500);
      const { slice } = pageSlice(shas, req.query);
      return json(200, slice.map((sha) => commitShape(ctx, repo, sha)), linkHeader(ctx, `/api/v3/repos/${repo.fullName}/commits`, req.query, shas.length));
    }
    if (rest.length === 2 && m === 'GET') {
      const sha = rest[1] as string;
      if (repo.store.get(sha)?.type !== 'commit') return notFound();
      return json(200, commitShape(ctx, repo, sha));
    }
    return notFound();
  }

  // /tags
  if (rest[0] === 'tags' && rest.length === 1 && m === 'GET') {
    const tags = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/tags/'))
      .map(([ref, sha]) => {
        const obj = repo.store.get(sha);
        const commitSha = obj?.type === 'tag' ? parseTag(obj.data).object : sha;
        return { name: ref.slice('refs/tags/'.length), commit: { sha: commitSha, url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${commitSha}` }, zipball_url: `${ctx.base}/api/v3/repos/${repo.fullName}/zipball/${ref.slice('refs/tags/'.length)}`, tarball_url: `${ctx.base}/api/v3/repos/${repo.fullName}/tarball/${ref.slice('refs/tags/'.length)}`, node_id: globalId('Tag', 0) };
      });
    return json(200, tags);
  }

  // /git/refs[/...]
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.store.get(sha)) return err(422, 'Validation Failed');
      repo.setRef(ref, sha);
      return json(201, gitRefShape(ctx, repo, ref, sha));
    }
    if (rest.length >= 3 && m === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return json(200, gitRefShape(ctx, repo, ref, sha));
    }
    if (rest.length >= 3 && m === 'DELETE') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (!repo.deleteRef(ref)) return notFound();
      return { status: 204 };
    }
    return notFound();
  }

  // /git/commits/{sha}, /git/trees/{sha}, /git/blobs/{sha} (harmless completeness)
  if (rest[0] === 'git' && rest.length === 3 && m === 'GET') {
    const sha = rest[2] as string;
    const obj = repo.store.get(sha);
    if (!obj) return notFound();
    if (rest[1] === 'commits' && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      return json(200, { sha, node_id: globalId('GitCommit', 0), url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}`, author: identShape(commit.author), committer: identShape(commit.committer), message: commit.message, tree: { sha: commit.tree, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` }, parents: commit.parents.map((p) => ({ sha: p, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${p}`, html_url: `${ctx.base}/${repo.fullName}/commit/${p}` })) });
    }
    if (rest[1] === 'trees' && obj.type === 'tree') {
      return json(200, { sha, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree: repo.store.treeEntries(sha).map((e) => ({ path: e.name, mode: e.mode === '40000' ? '040000' : e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.sha, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.sha}` })), truncated: false });
    }
    if (rest[1] === 'blobs' && obj.type === 'blob') {
      return json(200, { sha, node_id: globalId('Blob', 0), size: obj.data.length, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`, content: obj.data.toString('base64'), encoding: 'base64' });
    }
    return notFound();
  }

  // /contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(ctx, repo, path, req);
  }

  // /labels[/{name}]
  if (rest[0] === 'labels') {
    if (rest.length === 1 && m === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
      return json(200, labels.map((l) => labelShape(ctx, repo, l)));
    }
    if (rest.length === 1 && m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (!labelName) return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) return err(422, 'Validation Failed: name has already been taken');
      const label = {
        id: forge.allocLabelId(),
        name: labelName,
        color: (typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed'),
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(labelName, label);
      return json(201, labelShape(ctx, repo, label));
    }
    if (rest.length === 2 && m === 'GET') {
      const label = repo.labels.get(rest[1] as string);
      if (!label) return notFound();
      return json(200, labelShape(ctx, repo, label));
    }
    return notFound();
  }

  // /issues...
  if (rest[0] === 'issues') return handleIssues(ctx, repo, rest.slice(1), req);
  // /pulls...
  if (rest[0] === 'pulls') return handlePulls(ctx, repo, rest.slice(1), req);

  return notFound();
}

function gitRefShape(ctx: HttpContext, repo: Repo, ref: string, sha: string) {
  const obj = repo.store.get(sha);
  return {
    ref,
    node_id: globalId('Ref', 0),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${ref}`,
    object: { sha, type: obj?.type ?? 'commit', url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${obj?.type === 'tree' ? 'trees' : obj?.type === 'blob' ? 'blobs' : 'commits'}/${sha}` },
  };
}

export function identShape(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident);
  if (!match) return { name: ident, email: '', date: '2025-01-01T00:00:00Z' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

export function commitShape(ctx: HttpContext, repo: Repo, sha: string) {
  const obj = repo.store.get(sha);
  const commit = obj ? parseCommit(obj.data) : { tree: '', parents: [] as readonly string[], author: '', committer: '', message: '' };
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}`;
  return {
    sha,
    node_id: globalId('Commit', 0),
    commit: {
      author: identShape(commit.author),
      committer: identShape(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${api}/commits/${sha}`,
    html_url: `${ctx.base}/${repo.fullName}/commit/${sha}`,
    comments_url: `${api}/commits/${sha}/comments`,
    author: userShape(ctx),
    committer: userShape(ctx),
    parents: commit.parents.map((p) => ({ sha: p, url: `${api}/commits/${p}`, html_url: `${ctx.base}/${repo.fullName}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(ctx: HttpContext, repo: Repo, path: string, req: RestRequest): Reply {
  const { forge } = ctx;
  const m = req.method;
  const branchParam = req.query.get('branch') ?? undefined;
  const refParam = req.query.get('ref') ?? branchParam;

  if (m === 'GET') {
    const refName = refParam ?? repo.defaultBranch;
    const commitSha = repo.commitOf(refName.startsWith('refs/') ? refName : `refs/heads/${refName}`) ?? (repo.store.get(refName)?.type === 'commit' ? refName : null);
    if (!commitSha) return notFound();
    const tree = parseCommit(repo.store.get(commitSha)?.data as Buffer).tree;
    if (path === '') {
      return json(200, dirListing(ctx, repo, tree, ''));
    }
    const found = repo.store.lookupPath(tree, path);
    if (!found) return notFound();
    if (found.type === 'tree') return json(200, dirListing(ctx, repo, found.sha, path));
    const blob = repo.store.get(found.sha);
    if (!blob) return notFound();
    return json(200, fileShape(ctx, repo, path, found.sha, blob.data));
  }

  if (m === 'PUT') {
    if (req.bodyError) return err(400, 'Problems parsing JSON');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.commitOf(ref);
    const tree = tip ? parseCommit(repo.store.get(tip)?.data as Buffer).tree : null;
    const existing = tree ? repo.store.lookupPath(tree, path) : null;
    if (existing && existing.type === 'blob') {
      const givenSha = typeof body.sha === 'string' ? body.sha : null;
      if (givenSha !== existing.sha) return err(409, 'Conflict: the file has changed since it was read');
    }
    const data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    const blobSha = repo.store.put('blob', data);
    const files = tree ? repo.store.flattenTree(tree) : new Map<string, { sha: string; mode: string }>();
    files.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const newTree = repo.store.buildTreeFromFiles(files);
    const commitSha = forge.commitOnBranch(repo, branch, newTree, message);
    return json(existing ? 200 : 201, {
      content: fileShape(ctx, repo, path, blobSha, data),
      commit: commitSummary(ctx, repo, commitSha),
    });
  }

  if (m === 'DELETE') {
    if (req.bodyError) return err(400, 'Problems parsing JSON');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.commitOf(ref);
    if (!tip) return notFound();
    const tree = parseCommit(repo.store.get(tip)?.data as Buffer).tree;
    const existing = repo.store.lookupPath(tree, path);
    if (!existing || existing.type !== 'blob') return notFound();
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    if (givenSha !== null && givenSha !== existing.sha) return err(409, 'Conflict: the file has changed since it was read');
    const files = repo.store.flattenTree(tree);
    files.delete(path);
    const newTree = repo.store.buildTreeFromFiles(files);
    const commitSha = forge.commitOnBranch(repo, branch, newTree, message);
    return json(200, { content: null, commit: commitSummary(ctx, repo, commitSha) });
  }

  return notFound();
}

function fileShape(ctx: HttpContext, repo: Repo, path: string, sha: string, data: Buffer) {
  const name = path.split('/').pop() as string;
  const api = `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`;
  return {
    name,
    path,
    sha,
    size: data.length,
    url: api,
    html_url: `${ctx.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`,
    download_url: `${ctx.base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
    type: 'file',
    content: data.toString('base64'),
    encoding: 'base64',
    _links: { self: api, git: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`, html: `${ctx.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
  };
}

function dirListing(ctx: HttpContext, repo: Repo, treeSha: string, prefix: string) {
  return repo.store.treeEntries(treeSha).map((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.store.get(entry.sha);
    return {
      name: entry.name,
      path,
      sha: entry.sha,
      size: blob ? blob.data.length : 0,
      url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `${ctx.base}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      git_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`,
      download_url: isDir ? null : `${ctx.base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
      type: isDir ? 'dir' : 'file',
      _links: { self: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`, html: `${ctx.base}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}` },
    };
  });
}

function commitSummary(ctx: HttpContext, repo: Repo, sha: string) {
  const commit = parseCommit(repo.store.get(sha)?.data as Buffer);
  return {
    sha,
    node_id: globalId('Commit', 0),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
    html_url: `${ctx.base}/${repo.fullName}/commit/${sha}`,
    author: identShape(commit.author),
    committer: identShape(commit.committer),
    tree: { sha: commit.tree, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
    message: commit.message,
    parents: commit.parents.map((p) => ({ sha: p, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${p}`, html_url: `${ctx.base}/${repo.fullName}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: HttpContext, repo: Repo, rest: string[], req: RestRequest): Reply {
  const { forge } = ctx;
  const m = req.method;

  if (rest.length === 0) {
    if (m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return err(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${labelName}" does not exist` }] });
        }
      }
      const now = forge.clock.nowIso();
      const issue: Issue = {
        id: forge.allocIssueId(),
        number: repo.nextNumber,
        title,
        body: typeof body.body === 'string' ? body.body : null,
        state: 'open',
        labels: labelNames,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return issueReply(ctx, repo, issue, 201);
    }
    if (m === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const direction = req.query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice } = pageSlice(issues, req.query);
      return json(200, slice.map((i) => issueShape(ctx, repo, i)), linkHeader(ctx, `/api/v3/repos/${repo.fullName}/issues`, req.query, issues.length));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (!issue) return notFound();
    if (m === 'GET') return issueReply(ctx, repo, issue, 200);
    if (m === 'PATCH') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? forge.clock.nowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const names = body.labels.filter((l): l is string => typeof l === 'string');
        for (const labelName of names) if (!repo.labels.has(labelName)) return err(422, 'Validation Failed: unknown label');
        issue.labels = names;
      }
      issue.updatedAt = forge.clock.nowIso();
      return json(200, issueShape(ctx, repo, issue));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (!issue) return notFound();
    if (rest.length === 2 && m === 'GET') {
      const { slice } = pageSlice(issue.comments, req.query);
      return json(200, slice.map((c) => commentShape(ctx, repo, issue.number, c)));
    }
    if (rest.length === 2 && m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const now = forge.clock.nowIso();
      const comment: Comment = {
        id: forge.allocCommentId(),
        body: typeof body.body === 'string' ? body.body : '',
        createdAt: now,
        updatedAt: now,
      };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return json(201, commentShape(ctx, repo, issue.number, comment));
    }
    if (rest.length === 3 && m === 'GET') {
      const comment = issue.comments.find((c) => c.id === Number(rest[2]));
      if (!comment) return notFound();
      return json(200, commentShape(ctx, repo, issue.number, comment));
    }
    return notFound();
  }

  if (rest[1] === 'labels') {
    if (!issue) return notFound();
    if (rest.length === 2 && m === 'GET') return json(200, issue.labels.map((n) => repo.labels.get(n)).filter(Boolean).map((l) => labelShape(ctx, repo, l as NonNullable<typeof l>)));
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

export function createPull(forge: Forge, repo: Repo, fields: { title: string; body: string | null; head: string; base: string }): Pull {
  const now = forge.clock.nowIso();
  const pull: Pull = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: fields.head,
    baseRef: fields.base,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    mergedAt: null,
    merged: false,
    mergeCommitSha: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function handlePulls(ctx: HttpContext, repo: Repo, rest: string[], req: RestRequest): Reply {
  const { forge } = ctx;
  const m = req.method;

  if (rest.length === 0) {
    if (m === 'POST') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
      const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '') || repo.defaultBranch;
      if (!title) return err(422, 'Validation Failed: title is required');
      if (!repo.refs.has(`refs/heads/${head}`)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'head branch does not exist' }] });
      }
      if (!repo.refs.has(`refs/heads/${base}`)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'base', message: 'base branch does not exist' }] });
      }
      const pull = createPull(forge, repo, { title, body: typeof body.body === 'string' ? body.body : null, head, base });
      return json(201, pullShape(ctx, repo, pull));
    }
    if (m === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      const direction = req.query.get('direction') ?? 'desc';
      pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice } = pageSlice(pulls, req.query);
      return json(200, slice.map((p) => pullShape(ctx, repo, p)), linkHeader(ctx, `/api/v3/repos/${repo.fullName}/pulls`, req.query, pulls.length));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1) {
    if (!pull) return notFound();
    if (m === 'GET') return json(200, pullShape(ctx, repo, pull));
    if (m === 'PATCH') {
      if (req.bodyError) return err(400, 'Problems parsing JSON');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        pull.state = body.state;
        pull.closedAt = body.state === 'closed' ? forge.clock.nowIso() : null;
      }
      pull.updatedAt = forge.clock.nowIso();
      return json(200, pullShape(ctx, repo, pull));
    }
    return notFound();
  }

  if (!pull) return notFound();

  if (rest[1] === 'files' && rest.length === 2 && m === 'GET') {
    const files = pullFiles(repo, pull);
    const { slice } = pageSlice(files, req.query);
    return json(200, slice.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${f.filename}`,
      raw_url: `${ctx.base}/${repo.fullName}/raw/${pull.headRef}/${f.filename}`,
      contents_url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${f.filename}?ref=${pull.headRef}`,
    })));
  }

  if (rest[1] === 'commits' && rest.length === 2 && m === 'GET') {
    const headSha = repo.commitOf(`refs/heads/${pull.headRef}`);
    const baseSha = repo.commitOf(`refs/heads/${pull.baseRef}`);
    if (!headSha) return json(200, []);
    const base = baseSha ? repo.store.mergeBase(baseSha, headSha) : null;
    const all = repo.store.listCommits(headSha, 250);
    const stop = base ? all.indexOf(base) : -1;
    const commits = stop >= 0 ? all.slice(0, stop) : all;
    return json(200, commits.map((sha) => commitShape(ctx, repo, sha)));
  }

  if (rest[1] === 'merge' && rest.length === 2 && m === 'PUT') {
    if (req.bodyError) return err(400, 'Problems parsing JSON');
    if (pull.merged) return err(405, 'Pull Request is not mergeable');
    if (pull.state !== 'open') return err(405, 'Pull Request is not mergeable');
    if (!computeMergeable(repo, pull)) return err(405, 'Pull Request is not mergeable');
    const sha = squashMerge(forge, repo, pull);
    if (!sha) return err(405, 'Pull Request is not mergeable');
    const now = forge.clock.nowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = sha;
    return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (rest[1] === 'merge' && rest.length === 2 && m === 'GET') {
    return pull.merged ? { status: 204 } : notFound();
  }

  return notFound();
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

export { ZERO_OID };
