// app.ts — the forge's HTTP server: one process serving git smart HTTP (/{owner}/{repo}.git),
// REST v3 (/api/v3), GraphQL v4 (/api/graphql) and MCP (/mcp) from one in-memory store.
// main.ts owns the entry<->env lifecycle; this file is the whole surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './store.ts';
import { handleRest, type HttpContext, type Reply, type RestRequest } from './rest.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `FORGE-${String(requestCounter).padStart(6, '0')}`;
      try {
        await route(req, res, forge, requestId);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
        }
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      }
    })();
  });
  // The read workload holds one keep-alive connection for 2,000 requests; keep it welcome.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse, forge: Forge, requestId: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? '127.0.0.1';
  const ctx: HttpContext = { forge, base: `http://${host}`, requestId };

  const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId,
      ...headers,
    });
    res.end(text);
  };
  const sendReply = (reply: Reply): void => {
    if (reply.rawBody) {
      res.writeHead(reply.status, {
        'content-type': reply.contentType ?? JSON_TYPE,
        'content-length': reply.rawBody.length,
        'x-github-request-id': requestId,
        ...(reply.headers ?? {}),
      });
      res.end(reply.rawBody);
      return;
    }
    if (reply.status === 204 || reply.body === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(reply.status, reply.body, reply.headers);
  };

  // The env's boot probe takes no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(200, { ok: true });
    return;
  }

  // Auth: every other surface presents the trial's bearer token.
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorization = req.headers.authorization ?? '';
  const authorized = expectedToken === '' || authorization === `Bearer ${expectedToken}`;
  if (!authorized) {
    sendJson(401, { message: 'Bad credentials' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const endpoint = gitMatch[3] as string;
    const protocol = req.headers['git-protocol'] as string | undefined;
    if (endpoint === 'info/refs' && method === 'GET') {
      const reply = infoRefs(forge, owner, name, url.searchParams.get('service') ?? '', protocol ?? null);
      res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length, 'x-github-request-id': requestId, 'cache-control': 'no-cache' });
      res.end(reply.body);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const reply = uploadPack(forge, owner, name, body, protocol ?? null);
      res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length, 'x-github-request-id': requestId });
      res.end(reply.body);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const reply = receivePack(forge, owner, name, body);
      res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length, 'x-github-request-id': requestId });
      res.end(reply.body);
      return;
    }
    sendJson(404, { message: 'Not Found' });
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'POST') {
      const body = await readBody(req);
      const reply = handleMcp(ctx, body);
      if (reply.body === undefined) {
        res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
        res.end();
        return;
      }
      sendJson(reply.status, reply.body, reply.headers);
      return;
    }
    if (method === 'GET' || method === 'DELETE') {
      res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    sendJson(404, { message: 'Not Found' });
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    sendJson(200, executeGraphQL(forge, parsed));
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path.slice('/api/v3'.length).split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
    let body: unknown;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyError = true;
        }
      }
    }
    const restReq: RestRequest = { method, segments, query: url.searchParams, body, bodyError };
    sendReply(handleRest(ctx, restReq));
    return;
  }

  // The viewer login is the only other named surface the suite probes (MCP setup reads it).
  void VIEWER;
  sendJson(404, { message: 'Not Found' });
}
