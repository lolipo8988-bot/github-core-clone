# SPEC — make.fun bounty `github-core-clone-01`

Source of truth: kit `RULES.txt` + `GET https://make.fun/api/competitions/github-core-clone-01/requirements`
+ the suite source shipped in the kit (`program/env/src/`, byte-identical to what grades submissions).
Retrieved 2026-11-17. Deadline: **2026-11-21T06:30:00Z** (14:30 Asia/Kuala_Lumpur).

## The task (official wording, condensed)

Write a standalone, GitHub-compatible git forge. It runs as one process in the trial's pod,
binds an ephemeral port of its own, and serves from its own store with no UI:

- git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push
- the REST v3 API under `/api/v3` for repositories, issues, pull requests and contents
- the GraphQL v4 API at `/api/graphql`
- a Model Context Protocol endpoint at `/mcp`

The suite in the pod is its only client, and a sealed scorer turns the suite's export into the score.
Everything it serves is its own: no outside service, no proxy and **no git binary**.

## Lifecycle (the wire)

1. Program binds an ephemeral port (`listen(0)`). It must not bind 8080 (the suite listens there).
2. It POSTs `{"port": <port>}` to `$MAKEFUN_ENV_URL/register`.
3. The suite records the source address, dials that address+port, and drives the forge:
   conformance checks first, then the four timed workloads.
4. Meanwhile the program polls `GET $MAKEFUN_ENV_URL/done` → `{"done": false}` until the suite has
   finished and written its export, then `{"done": true}`; on that answer the program exits 0.
5. A program that exits, crashes or never registers before the boot budget ends scores 0.
   A trial still running at its wall (900 s) is stopped and scores 0 on every column.

## Runtime / sandbox constraints

- Entry point: `main.ts` (Node 22) or `main.py` (Python 3.13) **in the repository root**;
  run as `node /bot/main.ts` — standard library plus vendored source only, **no install step,
  no dependencies, no package manager, no internet, no git binary**.
- Repository mounted read-only at `/bot`; may write only under `/tmp`.
- 2 CPUs, 1024 MB memory, 256 processes, 900 s wall budget (shared with the suite).
- Source caps: ≤ 16 MiB total, ≤ 8 MiB in any one file.
- Deterministic: two runs on the same instance must leave the same state export byte for byte;
  keep every time out of that state (the state export holds only pass/fail bits and counts).
- Environment given to the entry includes `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN` (the bearer
  token every API call presents), `MAKEFUN_TRIAL_NOW` (the instance's opening time — the only
  "now" a request may carry), `MAKEFUN_TRIAL_SEED`.

## Auth & ownership

- Every surface presents `Authorization: Bearer <token>` where token = the process's
  `MAKEFUN_SHOP_TOKEN`. A request without it (or with a wrong one) is **401**.
- A repository belongs to the login the token names: the same repository name under another
  owner is **404, never 403**.
- The suite's fixed scenario (kit `wire.ts`, `SCENARIO_SEED`, same in every trial) names the
  token owner **login `adaiversen`, id 1000**; checks address repositories as
  `/repos/adaiversen/<name>` and git remotes as `/adaiversen/<repo>.git`.

## REST v3 wire contract (required replies)

- Every REST reply is `application/json`, never HTML, and carries a non-empty
  `X-GitHub-Request-Id` header. An error carries a JSON body with a string `message`.
  No `X-RateLimit-*` header is required.
- `GET /api/v3/` → 200 JSON with an `X-OAuth-Scopes` header (starter answers `repo, read:org`).
- `GET /api/v3/meta` → 200 with a non-empty `installed_version` string.
- `GET /api/v3/user/repos` → 200 list; more than one page links the next with a `Link` header
  whose rel is `"next"` (pagination checked at per_page=10 over 30 repos).
- `POST /api/v3/user/repos` → 201, the repository object (round-trips name, private, default_branch).
- `GET /api/v3/repos/{owner}/{repo}` → 200 the repository; 404 JSON when it does not exist.
- `PATCH /api/v3/repos/{owner}/{repo}` → 200, description updated.
- `DELETE /api/v3/repos/{owner}/{repo}` → 204, and a later GET is 404.
- `GET /api/v3/repos/{owner}/{repo}/branches` lists branches (incl. one created via
  `POST /api/v3/repos/{owner}/{repo}/git/refs`).
- `GET /api/v3/repos/{owner}/{repo}/commits` reflects commits per branch (`?sha=<branch>`).
- `PUT .../contents/{path}` → 201 on create, 200 on update, **409 on a stale sha**;
  creates a real commit; `GET` returns base64 content and the blob sha; `GET` on a directory
  lists its entries.
- `DELETE .../contents/{path}` → 200 `{commit:{sha}}`, 404 on a later GET.
- `POST .../labels` → 201 `{name}`; a label must be created here before an issue may carry it.
- `POST .../issues` → 201, an open issue (numbers increment per repo, shared with PRs as on
  GitHub); **422 when it names a label that does not exist**. List supports
  `state`, `sort=created&direction=asc|desc`; issue shape is GitHub's. `PATCH .../issues/{n}`
  closes it and persists. `POST/GET .../issues/{n}/comments`.
- `POST .../pulls` → 201, state open, with head and base (head.sha = head branch tip,
  base.sha = base branch tip). `GET .../pulls/{number}` → 200; 404 when unknown.
  `GET .../pulls/{n}/files` lists every changed path with filename, status, additions/deletions/changes.
  List: `?state=all` lists open and merged; default is open only.
- `PUT .../pulls/{number}/merge` (squash) → 200 `{sha, merged:true, message}`: the pull is closed
  and merged (merged_at set, `merge_commit_sha` = the merge sha) and its squash commit is on the
  default branch; **404 for an unknown pull request, 405 for a conflicted one**.
- Any unknown route → 404 JSON, never HTML. Any malformed JSON body → 400.

## Git over smart HTTP

- A repository is created through REST (`POST /api/v3/user/repos`): a push cannot invent one.
  Its remote is `<base URL>/<owner>/<repo>.git`; the suite speaks smart HTTP in process.
- **upload-pack must speak protocol v2** (requested with `Git-Protocol: version=2`): the v2
  capability advertisement and both ls-refs checks require it; a v0 answer loses those three
  while the rest fall back to v0.
- **receive-pack is v0 only**, and must advertise `report-status`, `side-band-64k` and `delete-refs`.
- A v0 upload-pack that does not advertise `side-band-64k` cannot be framed.
- The v0 advertisements open with the `# service=git-upload-pack` / `# service=git-receive-pack`
  preamble; the v2 advertisement opens with `version 2`.
- A missing repository is 404 on both services' `GET /info/refs`, and the server stays up.
- Every update must fast-forward: a non-fast-forward push is refused per ref with
  `ng <ref> non-fast-forward` and the ref does not move; the suite never force-pushes.
  A mixed push applies the fast-forward ref and reports one line per ref (ok / ng).
- Checks (30): v2 advertisement, receive-pack advertisement, info/refs headers/preamble,
  unknown-repo 404, v2 ls-refs (refs, HEAD symref, peeled tags), ls-refs ref-prefix filtering,
  clone-empty, push-first-commit (unborn branch), clone object/blob/tree/commit byte-exactness,
  annotated tag round-trip + peel, incremental fetch (only new objects), fetch-nothing-new
  (no objects), shallow depth-1, deepen, shallow new tip, push update/create/delete branch,
  push non-fast-forward, mixed report, delete tag, 100-file push round-trip, pack integrity
  (checksum), pack deltas resolve (when sent), sideband framing (fetch + push report),
  server survives errors.

## GraphQL v4 (`POST /api/graphql`)

- Body `{"query": ..., "variables": {...}}` with the trial's bearer token; unauthenticated is
  exactly 401.
- Schema surface the checks use:
  - `Query.viewer { login }`
  - `Query.repository(owner:, name:)` → Repository, nullable (unknown repo →
    `data.repository = null` with **no** errors)
  - `Repository { id, databaseId, name, nameWithOwner, owner{login}, defaultBranchRef{name},
    viewerPermission, hasIssuesEnabled, issue(number:), issues(first:, states:, orderBy:, after:),
    pullRequests(first:), pullRequest(number:) }`
  - `Issue { id, number, title, state, body }`, `IssueConnection { nodes, pageInfo { hasNextPage, endCursor } }`
  - `PullRequest { id, number, state, merged, headRefName, baseRefName, mergeable, files(first:) }`,
    `PullRequestChangedFile { path }`
  - `Query.node(id:)` → Node, with inline fragments (`... on Repository`)
  - Introspection: `__type(name: "Issue")` lists id, number, title, state, body;
    `__type(name: "PullRequest")` lists id, number, headRefName, baseRefName, mergeable, state,
    merged, files; `__type(name: "Repository")` lists id, databaseId, name, nameWithOwner, owner,
    defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest;
    `SearchType`'s enumValues include ISSUE.
- `repository.issues` with `orderBy: {field: CREATED_AT, direction: DESC}` returns issue numbers
  descending, ties by number DESC; `states: [OPEN]` omits closed issues; cursor pagination
  (`first`/`after`) pages to the end.
- Mutations: `createIssue`, `closeIssue`, `createPullRequest` (takes a repository id and a head
  branch pushed over git; REST reads it back with the same head/base), `mergePullRequest`
  (SQUASH; REST then shows merged: true), `addComment` (REST lists the comment).
- Two operation documents in one body answer two results in order.
- A query naming an unknown field is HTTP 200 with an `errors` array naming it.
- Global ids are opaque and equal on repeated reads (stable across reads).

## MCP (`POST /mcp`)

- JSON-RPC 2.0 over Streamable HTTP, answering `application/json` or `text/event-stream`;
  each request must answer inside 3 seconds.
- Speaks revision **2026-07-28** (every request declares it; `server/discover` answers a result
  whose `supportedVersions` is a non-empty list of YYYY-MM-DD revisions), or a handshake revision
  (2025-11-25 or earlier) through `initialize` + `notifications/initialized` with an optional
  `Mcp-Session-Id`.
- `tools/list` offers **at least six tools**, including `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request` (a server prefix like
  `github__create_issue` is allowed; matched as suffix, case-insensitively). Every tool has a
  non-empty description and an `inputSchema` of type object; two `tools/list` calls answer the
  same list, byte for byte.
- Tool arguments (as github-mcp-server documents): create_repo `{name}`, get_repo `{owner, repo}`,
  create_issue `{owner, repo, title, body?}`, list_issues `{owner, repo, state?}`,
  create_pull_request `{owner, repo, title, head, base}`, merge_pull_request `{owner, repo, pull_number}`.
  The suite maps each argument onto the schema's nearest property name and fills a `full_name`
  property with `owner/repo` when the schema declares one.
- Two tools/call requests in flight keep their own JSON-RPC ids and answer for their own arguments.
- Unknown tool → JSON-RPC **-32602 or -32601**, never HTTP 500. tools/call missing a required
  argument → `isError: true` or -32602. A body that is not JSON → HTTP 400 with **-32700**
  (200 with -32700 from a pre-2026-07-28 server). A call with no Authorization header → 401.
- Tools act on the **same store as REST**: a repo/issue created over MCP reads back over
  `/api/v3` as the same objects, ids unchanged across reads.

## Scoring (0–1000)

- **Feature, 600**: `round(600 × passed / total)` over the conformance checks
  (git 30 + repos 15 + issues 15 + pulls 20 + graphql 20 + mcp 15 + protocol 5 = **120 checks**).
- **Agent-native, 200**: `round(200 × passed / total)` over the MCP checks again (15).
- **Performance, 200**: four timed workloads, each ≤ 50 points, median of 3 rounds after
  5 untimed warm-ups; points = `clamp(25 − 12.5 × log2(t / T_ref), 0, 50)` vs the house
  reference forge's calibrated medians (kit `program/env/src/calibration.json`):
  - push: 200 pushes of a 1 KiB change to one repository, sequentially
  - clone: 50 concurrent shallow clones (depth 1) of a 200-commit repository
  - read: 2,000 `GET /repos/{owner}/{repo}/issues/{number}` on one keep-alive connection
  - write: 200 issue creations, sequentially
- Prizes: top 20 places pay $100 / $70 / $50 / $20×7 / $14×10 — but a prize needs a score
  **strictly above the house reference forge's** (a statistical tie does not beat it).
  Current public entries already score up to ~937.

## Submission (for later — NOT part of this build step)

- Deliverables: public GitHub `repo_url` (required form field), `commit_sha` (full 40 chars,
  must be on a branch), and a transcript `bundle` (.tar.gz from the kit CLI).
- The repository must be owned by the entrant's GitHub account (or hold
  `.makefun/owner.json` `{"wallet": "<address>"}` naming a linked wallet), created at/after the
  competition opened (2026-11-14T06:30Z), under an OSI-approved license.
- At most 5 submissions/day, 10 total; the last submission before the deadline is the final entry.
- Each submission runs one live trial on practice instance 0; the final runs 3 scored instances
  drawn after the deadline, contenders replayed byte-for-byte.
