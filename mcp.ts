// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP.
// Speaks the 2026-07-28 revision (server/discover) and the handshake revisions (initialize +
// notifications/initialized). The six tools act on the same store as REST, so objects created
// over MCP read back over /api/v3 unchanged.

import { Forge, Repo, VIEWER } from './store.ts';
import { computeMergeable, createPull, issueShape, pullShape, repoShape, squashMerge, type HttpContext } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
      body: { type: 'string', description: 'The pull request body' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list result: built once so two calls answer byte for byte the same. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  })),
};

export interface McpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return undefined;
  return forge.getRepo(owner, name);
}

function callTool(ctx: HttpContext, name: string, args: Record<string, unknown>): McpReply | null {
  const { forge } = ctx;
  const tool = TOOLS.find((t) => t.name === name || name.toLowerCase().endsWith(t.name));
  if (!tool) return null;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(null, -32602, `missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) return rpcResult(null, toolError(`repository ${repoName} already exists`));
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return rpcResult(null, toolResult(repoShape(ctx, repo)));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (!repo) return rpcResult(null, toolError('repository not found'));
      return rpcResult(null, toolResult(repoShape(ctx, repo)));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (!repo) return rpcResult(null, toolError('repository not found'));
      const now = forge.clock.nowIso();
      const issue = {
        id: forge.allocIssueId(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open' as const,
        labels: [] as string[],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return rpcResult(null, toolResult(issueShape(ctx, repo, issue)));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (!repo) return rpcResult(null, toolError('repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return rpcResult(null, toolResult(issues.map((i) => issueShape(ctx, repo, i))));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (!repo) return rpcResult(null, toolError('repository not found'));
      const pull = createPull(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        head: String(args.head),
        base: String(args.base),
      });
      return rpcResult(null, toolResult(pullShape(ctx, repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (!repo) return rpcResult(null, toolError('repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return rpcResult(null, toolError('pull request not found'));
      if (!pull.merged && pull.state === 'open') {
        if (!computeMergeable(repo, pull)) return rpcResult(null, toolError('pull request is not mergeable'));
        const sha = squashMerge(forge, repo, pull);
        if (!sha) return rpcResult(null, toolError('pull request is not mergeable'));
        const now = forge.clock.nowIso();
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = now;
        pull.closedAt = now;
        pull.updatedAt = now;
        pull.mergeCommitSha = sha;
      }
      return rpcResult(null, toolResult(pullShape(ctx, repo, pull)));
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC request object. `id` is threaded back for the caller's envelope. */
function handleOne(ctx: HttpContext, request: Record<string, unknown>): McpReply {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        ...rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
        headers: { 'mcp-session-id': 'forge-session-1' },
      };
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const reply = callTool(ctx, name, args);
      if (!reply) return rpcError(id, -32601, `unknown tool: ${name}`);
      // Thread the caller's id into the tool reply envelope.
      const body = reply.body as { jsonrpc: string; id: unknown; result?: unknown; error?: unknown };
      return { status: reply.status, body: { ...body, id } };
    }
    default:
      if (isNotification) return { status: 202 };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** The /mcp endpoint. `rawBody` is the unparsed request body (parse errors are scored). */
export function handleMcp(ctx: HttpContext, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(ctx, (entry ?? {}) as Record<string, unknown>))
      .filter((reply) => reply.body !== undefined);
    if (!replies.length) return { status: 202 };
    return { status: 200, body: replies.map((reply) => reply.body) };
  }
  const reply = handleOne(ctx, (parsed ?? {}) as Record<string, unknown>);
  return reply;
}
