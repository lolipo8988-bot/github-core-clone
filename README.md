# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lolipo8988-bot/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lolipo8988-bot/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP (protocol v2 + v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all served from one in-memory store — no UI, no dependencies, no internet and no `git` binary.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=<the trial token> \
MAKEFUN_TRIAL_NOW=2025-01-01T00:00:00Z \
node --experimental-strip-types main.ts
```

The entry lifecycle (kit `main.ts`, unchanged): the process binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the suite
says the trial is over, and exits 0. Node 22+, standard library only (`node:http`, `node:crypto`,
`node:zlib`). The TypeScript is erasable-syntax only, so Node's type stripping runs it directly —
there is no build step and nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cz7ahbc3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

| Surface | Where |
| --- | --- |
| git smart HTTP | `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack` (protocol v2 + v0), `git-receive-pack` (v0) |
| REST v3 | `/api/v3` — repositories, branches, commits, contents, git refs, labels, issues, comments, pull requests (files + squash merge) |
| GraphQL v4 | `POST /api/graphql` — viewer, repository, issues/pull requests, the gh mutations, `node(id:)`, `__type` introspection |
| MCP | `POST /mcp` — JSON-RPC 2.0 over streamable HTTP (2026-07-28 `server/discover` + handshake revisions), six tools on the same store as REST |

## Grade it locally

The kit's env is the sealed suite, byte for byte. With the kit unpacked beside this repo:

```sh
KIT=<path to github-core-clone-01-kit>
STATE=/tmp/forge-state
MAKEFUN_SHOP_TOKEN=local-trial-token MAKEFUN_TRIAL_NOW=2025-01-01T00:00:00Z \
MAKEFUN_STATE_DIR=$STATE MAKEFUN_ENV_PORT=8080 node $KIT/program/env/server.mjs &
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=local-trial-token \
  node --experimental-strip-types main.ts
# the score lands in $STATE/export/state.json (pass bits) and perf.json (workload points)
```

Latest local result: **120/120 conformance checks**, state export byte-identical across runs
(and identical to the house reference forge's all-pass export), performance 168–187/200 on a
shared VM (the timed column is venue-sensitive; the reference medians were measured on the
production cluster).

## Layout

- `main.ts` — the entry ↔ env lifecycle (from the kit starter, kept as it is)
- `app.ts` — the HTTP server: routing, bearer auth, request ids
- `gitcore.ts` — SHA-1 objects, trees/commits/tags, packfile read (OFS/REF deltas) and write, pkt-lines, reachability + shallow boundaries
- `githttp.ts` — smart HTTP: v2/v0 advertisements, ls-refs, fetch (shallow/deepen, have negotiation), receive-pack with per-ref report-status
- `store.ts` — the domain store: repos, refs, issues, pull requests, labels, comments; deterministic clock seeded by `MAKEFUN_TRIAL_NOW`
- `rest.ts` — the REST v3 surface and GitHub JSON shapes
- `graphql.ts` — a compact GraphQL parser/executor for the v4 documents gh and github-mcp-server send
- `mcp.ts` — the MCP endpoint and its six tools

## Design notes

- **One store, four views.** Git objects live in a per-repo object map; REST contents writes and
  squash merges create real commits in it, and MCP tools mutate the same records REST reads, so
  ids and objects agree across surfaces.
- **Deterministic.** Every timestamp the forge emits derives from `MAKEFUN_TRIAL_NOW` plus a
  tick counter; request ids are counters; GraphQL global ids are stable encodings of the
  numeric ids. Two runs of the same trial answer byte-identically where the scorer compares.
- **Auth.** Every surface but `/healthz` requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
  a repository belongs to the token's login — the same name under another owner is 404, never 403.

## License

MIT (see `LICENSE`).
