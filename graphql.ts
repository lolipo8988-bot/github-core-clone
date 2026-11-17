// graphql.ts — a compact GraphQL parser/executor for the v4 surface the suite sends:
// viewer, repository fields, issue/pull-request reads with cursor pagination, the gh mutations
// (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), node(id:) and the
// __type introspection probes. Unknown fields answer HTTP 200 with an errors array, as GraphQL does.

import { Forge, Repo, VIEWER, type Issue, type Pull } from './store.ts';
import { computeMergeable, createPull, decodeGlobalId, globalId, pullFiles, squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selection?: SelectionSet;
  fragmentType?: string; // set for inline fragments: name is '' and fragmentType is the condition
}

type SelectionSet = FieldNode[];

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionSet;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:=@$!'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end < 0 ? source.length : end)}"`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as string;
      if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        this.next();
        let name: string | undefined;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek() as string)) name = this.next();
        if (this.peek() === '(') this.skipParens(); // variable definitions
        // Directives on the operation are not used by the suite; skip any @word(...) groups.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipParens();
        }
        operations.push({ type: token, name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        // Named fragments are not used by the suite's documents; parse and drop.
        this.next();
        this.next();
        this.expect('on');
        this.next();
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return operations;
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseSelectionSet(): SelectionSet {
    this.expect('{');
    const fields: SelectionSet = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      this.expect('on');
      const type = this.next();
      return { name: '', fragmentType: type, args: [], selection: this.parseSelectionSet() };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// schema: the field lists introspection reports
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Ref: ['name', 'prefix', 'target'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'mergeCommit'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'variable': return variables[value.name] ?? null;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(node: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of node.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

type Resolver = (source: unknown, args: Record<string, unknown>, node: FieldNode, ctx: ExecContext) => unknown;

function executeSelection(typeName: string, source: unknown, selection: SelectionSet, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.fragmentType) {
      if (node.fragmentType === typeName || node.fragmentType === 'Node') {
        Object.assign(out, executeSelection(typeName, source, node.selection ?? [], ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const resolver = RESOLVERS[typeName]?.[node.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = resolver(source, argsOf(node, ctx.variables), node, ctx);
  }
  return out;
}

function select(typeName: string, source: unknown, node: FieldNode, ctx: ExecContext): unknown {
  if (source === null || source === undefined) return null;
  if (!node.selection) return source;
  return executeSelection(typeName, source, node.selection, ctx);
}

function selectList(typeName: string, items: unknown[], node: FieldNode, ctx: ExecContext): unknown[] {
  return items.map((item) => select(typeName, item, node, ctx));
}

// --- domain wrappers --------------------------------------------------------

interface RepoSource { repo: Repo }
interface IssueSource { repo: Repo; issue: Issue }
interface PullSource { repo: Repo; pull: Pull }

function repoByGlobalId(forge: Forge, globalIdText: string): Repo | null {
  const decoded = decodeGlobalId(globalIdText);
  if (!decoded || decoded.type !== 'Repository') return null;
  for (const repo of forge.repos.values()) if (repo.id === decoded.id) return repo;
  return null;
}

function issueByGlobalId(forge: Forge, globalIdText: string): IssueSource | null {
  const decoded = decodeGlobalId(globalIdText);
  if (!decoded || decoded.type !== 'Issue') return null;
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === decoded.id) return { repo, issue };
  }
  return null;
}

function pullByGlobalId(forge: Forge, globalIdText: string): PullSource | null {
  const decoded = decodeGlobalId(globalIdText);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === decoded.id) return { repo, pull };
  }
  return null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>, node: FieldNode, ctx: ExecContext): unknown {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) {
    const wanted = states.map((s) => s.toLowerCase());
    issues = issues.filter((i) => wanted.includes(i.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction ?? 'ASC';
  issues.sort((a, b) => {
    const cmp = a.number - b.number; // creation order == number order; ties impossible
    return direction === 'DESC' ? -cmp : cmp;
  });
  const after = indexFromCursor(typeof args.after === 'string' ? args.after : null);
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = issues.slice(after + 1, after + 1 + first);
  const hasNext = after + 1 + page.length < issues.length;
  const connection = {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: after >= 0,
      startCursor: page.length ? cursorFor(after + 1) : null,
      endCursor: page.length ? cursorFor(after + page.length) : null,
    },
    totalCount: issues.length,
    edges: page.map((issue, i) => ({ node: { repo, issue }, cursor: cursorFor(after + 1 + i) })),
  };
  return select('IssueConnection', connection, node, ctx);
}

// --- resolvers ---------------------------------------------------------------

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_s, _a, node, ctx) => select('User', VIEWER, node, ctx),
    repository: (_s, args, node, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = owner === VIEWER.login ? ctx.forge.getRepo(owner, name) : undefined;
      if (!repo) return null;
      return select('Repository', { repo } satisfies RepoSource, node, ctx);
    },
    node: (_s, args, node, ctx) => {
      const idText = String(args.id ?? '');
      const decoded = decodeGlobalId(idText);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = repoByGlobalId(ctx.forge, idText);
        return repo ? select('Repository', { repo }, node, ctx) : null;
      }
      if (decoded.type === 'Issue') {
        const found = issueByGlobalId(ctx.forge, idText);
        return found ? select('Issue', found, node, ctx) : null;
      }
      if (decoded.type === 'PullRequest') {
        const found = pullByGlobalId(ctx.forge, idText);
        return found ? select('PullRequest', found, node, ctx) : null;
      }
      return null;
    },
    __type: (_s, args, node, ctx) => select('__Type', { name: String(args.name ?? '') }, node, ctx),
    __schema: (_s, _a, node, ctx) => select('__Schema', {}, node, ctx),
    search: (_s, _a, node, ctx) => select('SearchResultItemConnection', { nodes: [] }, node, ctx),
  },
  Mutation: {
    createIssue: (_s, args, node, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve Repository with the given id.' });
        return null;
      }
      const now = ctx.forge.clock.nowIso();
      const issue: Issue = {
        id: ctx.forge.allocIssueId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return select('CreateIssuePayload', { issue: { repo, issue } }, node, ctx);
    },
    closeIssue: (_s, args, node, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.forge, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve Issue with the given id.' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = ctx.forge.clock.nowIso();
      found.issue.updatedAt = found.issue.closedAt;
      return select('CloseIssuePayload', { issue: found }, node, ctx);
    },
    createPullRequest: (_s, args, node, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve Repository with the given id.' });
        return null;
      }
      const strip = (ref: string): string => ref.replace(/^refs\/heads\//, '');
      const head = strip(String(input.headRefName ?? input.headBranch ?? ''));
      const base = strip(String(input.baseRefName ?? input.baseBranch ?? '')) || repo.defaultBranch;
      const pull = createPull(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        head,
        base,
      });
      return select('CreatePullRequestPayload', { pullRequest: { repo, pull } }, node, ctx);
    },
    mergePullRequest: (_s, args, node, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx.forge, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve PullRequest with the given id.' });
        return null;
      }
      const { repo, pull } = found;
      if (!pull.merged && pull.state === 'open' && computeMergeable(repo, pull)) {
        const sha = squashMerge(ctx.forge, repo, pull);
        if (sha) {
          const now = ctx.forge.clock.nowIso();
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = now;
          pull.closedAt = now;
          pull.updatedAt = now;
          pull.mergeCommitSha = sha;
        }
      }
      return select('MergePullRequestPayload', { pullRequest: found }, node, ctx);
    },
    addComment: (_s, args, node, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const decoded = decodeGlobalId(subjectId);
      let target: IssueSource | PullSource | null = null;
      if (decoded?.type === 'Issue') target = issueByGlobalId(ctx.forge, subjectId);
      else if (decoded?.type === 'PullRequest') target = pullByGlobalId(ctx.forge, subjectId);
      if (!target) {
        ctx.errors.push({ message: 'Could not resolve subject with the given id.' });
        return null;
      }
      const now = ctx.forge.clock.nowIso();
      const comment = {
        id: ctx.forge.allocCommentId(),
        body: String(input.body ?? ''),
        createdAt: now,
        updatedAt: now,
      };
      if ('issue' in target) target.issue.comments.push(comment);
      return select('AddCommentPayload', { commentEdge: { node: comment, cursor: cursorFor(0) } }, node, ctx);
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => globalId('User', VIEWER.id),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `/users/${VIEWER.login}`,
    avatarUrl: () => '',
  },
  Repository: {
    id: (s) => globalId('Repository', (s as RepoSource).repo.id),
    databaseId: (s) => (s as RepoSource).repo.id,
    name: (s) => (s as RepoSource).repo.name,
    nameWithOwner: (s) => (s as RepoSource).repo.fullName,
    owner: (_s, _a, node, ctx) => select('User', VIEWER, node, ctx),
    defaultBranchRef: (s, _a, node, ctx) => {
      const repo = (s as RepoSource).repo;
      if (!repo.headSha()) return null;
      return select('Ref', { name: repo.defaultBranch }, node, ctx);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    isPrivate: (s) => (s as RepoSource).repo.isPrivate,
    description: (s) => (s as RepoSource).repo.description,
    url: (s) => `/${(s as RepoSource).repo.fullName}`,
    createdAt: (s) => (s as RepoSource).repo.createdAt,
    updatedAt: (s) => (s as RepoSource).repo.updatedAt,
    issue: (s, args, node, ctx) => {
      const repo = (s as RepoSource).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? select('Issue', { repo, issue }, node, ctx) : null;
    },
    issues: (s, args, node, ctx) => issueConnection((s as RepoSource).repo, args, node, ctx),
    pullRequest: (s, args, node, ctx) => {
      const repo = (s as RepoSource).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? select('PullRequest', { repo, pull }, node, ctx) : null;
    },
    pullRequests: (s, args, node, ctx) => {
      const repo = (s as RepoSource).repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) {
        pulls = pulls.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      pulls.sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? args.first : 100;
      const page = pulls.slice(0, first);
      const connection = {
        nodes: page.map((pull) => ({ repo, pull })),
        pageInfo: { hasNextPage: pulls.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: pulls.length,
        edges: page.map((pull) => ({ node: { repo, pull }, cursor: cursorFor(pull.number) })),
      };
      return select('PullRequestConnection', connection, node, ctx);
    },
  },
  Ref: {
    name: (s) => (s as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  Issue: {
    id: (s) => globalId('Issue', (s as IssueSource).issue.id),
    databaseId: (s) => (s as IssueSource).issue.id,
    number: (s) => (s as IssueSource).issue.number,
    title: (s) => (s as IssueSource).issue.title,
    state: (s) => (s as IssueSource).issue.state.toUpperCase(),
    body: (s) => (s as IssueSource).issue.body,
    url: (s) => `/${(s as IssueSource).repo.fullName}/issues/${(s as IssueSource).issue.number}`,
    author: (_s, _a, node, ctx) => select('User', VIEWER, node, ctx),
    createdAt: (s) => (s as IssueSource).issue.createdAt,
    updatedAt: (s) => (s as IssueSource).issue.updatedAt,
    closedAt: (s) => (s as IssueSource).issue.closedAt,
    repository: (s, _a, node, ctx) => select('Repository', { repo: (s as IssueSource).repo }, node, ctx),
    labels: (s, _a, node, ctx) => {
      const { repo, issue } = s as IssueSource;
      const nodes = issue.labels.map((name) => repo.labels.get(name)).filter(Boolean).map((l) => ({ id: globalId('Label', (l as { id: number }).id), name: (l as { name: string }).name, color: (l as { color: string }).color, description: (l as { description: string | null }).description }));
      return select('LabelConnection', { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length }, node, ctx);
    },
    comments: (s, _a, node, ctx) => {
      const { issue } = s as IssueSource;
      const nodes = issue.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt }));
      return select('IssueCommentConnection', { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length, edges: nodes.map((n) => ({ node: n, cursor: cursorFor(0) })) }, node, ctx);
    },
  },
  PullRequest: {
    id: (s) => globalId('PullRequest', (s as PullSource).pull.id),
    databaseId: (s) => (s as PullSource).pull.id,
    number: (s) => (s as PullSource).pull.number,
    title: (s) => (s as PullSource).pull.title,
    body: (s) => (s as PullSource).pull.body,
    state: (s) => ((s as PullSource).pull.merged ? 'MERGED' : (s as PullSource).pull.state.toUpperCase()),
    merged: (s) => (s as PullSource).pull.merged,
    mergedAt: (s) => (s as PullSource).pull.mergedAt,
    mergeable: (s) => {
      const { repo, pull } = s as PullSource;
      if (pull.merged) return 'UNKNOWN';
      return computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (s) => (s as PullSource).pull.headRef,
    baseRefName: (s) => (s as PullSource).pull.baseRef,
    author: (_s, _a, node, ctx) => select('User', VIEWER, node, ctx),
    url: (s) => `/${(s as PullSource).repo.fullName}/pull/${(s as PullSource).pull.number}`,
    createdAt: (s) => (s as PullSource).pull.createdAt,
    updatedAt: (s) => (s as PullSource).pull.updatedAt,
    closedAt: (s) => (s as PullSource).pull.closedAt,
    repository: (s, _a, node, ctx) => select('Repository', { repo: (s as PullSource).repo }, node, ctx),
    files: (s, args, node, ctx) => {
      const { repo, pull } = s as PullSource;
      const files = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : 100;
      const page = files.slice(0, first);
      const connection = {
        nodes: page.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' })),
        pageInfo: { hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
        edges: [],
      };
      return select('PullRequestChangedFileConnection', connection, node, ctx);
    },
  },
  PullRequestChangedFile: {
    path: (s) => (s as { path: string }).path,
    additions: (s) => (s as { additions: number }).additions,
    deletions: (s) => (s as { deletions: number }).deletions,
    changeType: (s) => (s as { changeType: string }).changeType,
  },
  IssueConnection: {
    nodes: (s, _a, node, ctx) => selectList('Issue', (s as { nodes: unknown[] }).nodes, node, ctx),
    edges: (s, _a, node, ctx) => (s as { edges: unknown[] }).edges.map((edge) => select('IssueEdge', edge, node, ctx)),
    pageInfo: (s, _a, node, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, node, ctx),
    totalCount: (s) => (s as { totalCount: number }).totalCount,
  },
  IssueEdge: {
    node: (s, _a, node, ctx) => select('Issue', (s as { node: unknown }).node, node, ctx),
    cursor: (s) => (s as { cursor: string }).cursor,
  },
  PullRequestConnection: {
    nodes: (s, _a, node, ctx) => selectList('PullRequest', (s as { nodes: unknown[] }).nodes, node, ctx),
    edges: (s, _a, node, ctx) => (s as { edges: unknown[] }).edges.map((edge) => select('PullRequestEdge', edge, node, ctx)),
    pageInfo: (s, _a, node, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, node, ctx),
    totalCount: (s) => (s as { totalCount: number }).totalCount,
  },
  PullRequestEdge: {
    node: (s, _a, node, ctx) => select('PullRequest', (s as { node: unknown }).node, node, ctx),
    cursor: (s) => (s as { cursor: string }).cursor,
  },
  PullRequestChangedFileConnection: {
    nodes: (s, _a, node, ctx) => selectList('PullRequestChangedFile', (s as { nodes: unknown[] }).nodes, node, ctx),
    edges: () => [],
    pageInfo: (s, _a, node, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, node, ctx),
    totalCount: (s) => (s as { totalCount: number }).totalCount,
  },
  IssueCommentConnection: {
    nodes: (s, _a, node, ctx) => selectList('IssueComment', (s as { nodes: unknown[] }).nodes, node, ctx),
    edges: (s, _a, node, ctx) => (s as { edges: unknown[] }).edges.map((edge) => select('IssueCommentEdge', edge, node, ctx)),
    pageInfo: (s, _a, node, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, node, ctx),
    totalCount: (s) => (s as { totalCount: number }).totalCount,
  },
  IssueCommentEdge: {
    node: (s, _a, node, ctx) => select('IssueComment', (s as { node: unknown }).node, node, ctx),
    cursor: (s) => (s as { cursor: string }).cursor,
  },
  IssueComment: {
    id: (s) => globalId('IssueComment', (s as { id: number }).id),
    body: (s) => (s as { body: string }).body,
    createdAt: (s) => (s as { createdAt: string }).createdAt,
    author: (_s, _a, node, ctx) => select('User', VIEWER, node, ctx),
    url: () => '',
  },
  LabelConnection: {
    nodes: (s, _a, node, ctx) => selectList('Label', (s as { nodes: unknown[] }).nodes, node, ctx),
    pageInfo: (s, _a, node, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, node, ctx),
    totalCount: (s) => (s as { totalCount: number }).totalCount,
  },
  Label: {
    id: (s) => (s as { id: string }).id,
    name: (s) => (s as { name: string }).name,
    color: (s) => (s as { color: string }).color,
    description: (s) => (s as { description: string | null }).description,
  },
  PageInfo: {
    hasNextPage: (s) => (s as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (s) => (s as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (s) => (s as { startCursor: string | null }).startCursor,
    endCursor: (s) => (s as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (s, _a, node, ctx) => select('Issue', (s as { issue: unknown }).issue, node, ctx),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (s, _a, node, ctx) => select('Issue', (s as { issue: unknown }).issue, node, ctx),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (s, _a, node, ctx) => select('PullRequest', (s as { pullRequest: unknown }).pullRequest, node, ctx),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (s, _a, node, ctx) => select('PullRequest', (s as { pullRequest: unknown }).pullRequest, node, ctx),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (s, _a, node, ctx) => select('IssueCommentEdge', (s as { commentEdge: unknown }).commentEdge, node, ctx),
    subject: () => null,
    clientMutationId: () => null,
  },
  SearchResultItemConnection: {
    nodes: () => [],
    pageInfo: (s, _a, node, ctx) => select('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, node, ctx),
  },
  __Type: {
    name: (s) => (s as { name: string }).name,
    kind: (s) => {
      const name = (s as { name: string }).name;
      if (name === 'SearchType' || ENUM_VALUES[name]) return 'ENUM';
      return 'OBJECT';
    },
    description: () => null,
    fields: (s, _a, node, ctx) => {
      const name = (s as { name: string }).name;
      const fields = TYPE_FIELDS[name] ?? [];
      return fields.map((fieldName) => select('__Field', { name: fieldName }, node, ctx));
    },
    enumValues: (s, _a, node, ctx) => {
      const name = (s as { name: string }).name;
      const values = ENUM_VALUES[name] ?? [];
      return values.map((valueName) => select('__EnumValue', { name: valueName }, node, ctx));
    },
    possibleTypes: () => [],
    inputFields: () => [],
    interfaces: () => [],
    ofType: () => null,
  },
  __Field: {
    name: (s) => (s as { name: string }).name,
    description: () => null,
    args: () => [],
    type: (_s, _a, node, ctx) => select('__Type', { name: 'String' }, node, ctx),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => (s as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: (_s, _a, node, ctx) => select('__Type', { name: 'Query' }, node, ctx),
    mutationType: (_s, _a, node, ctx) => select('__Type', { name: 'Mutation' }, node, ctx),
    subscriptionType: () => null,
    types: () => [],
    directives: () => [],
  },
};

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function executeGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(forge, entry));
  }
  return executeOne(forge, body);
}

function executeOne(forge: Forge, body: unknown): GraphQLResult {
  const request = (body ?? {}) as { query?: unknown; variables?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(request.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Syntax error' }] };
  }
  const operation = operations[0];
  if (!operation) return { errors: [{ message: 'No operation found.' }] };
  const ctx: ExecContext = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, operation.selection, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
