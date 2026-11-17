# PROGRESS — github-core-clone-01

Updated 2026-11-17 (Asia/Kuala_Lumpur). Deadline: 2026-11-21T06:30:00Z.

## Status: locally complete — 120/120 conformance, waiting on a GitHub account to submit

The full sealed suite from the kit was run locally three times (env `program/env/server.mjs`
+ this entry, exactly the grading shape):

| Run | Conformance | Perf points (of 200) | Notes |
| --- | --- | --- | --- |
| 1 | 119/120 | 175 | `git.fetch-shallow-deepen` failed — have-exclusion ignored the client's shallow boundary |
| 2 | **120/120** | 168 | after the `excludeStopAt` fix |
| 3 | **120/120** | 187 | read + write workloads at the 50-point cap |

- `export/state.json` sha256 is identical across runs 2 and 3:
  `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590` — the same hash the kit's
  `calibration.json` records for the house reference forge's all-pass export. Replay
  determinism (the final's byte-for-byte requirement) holds.
- Local score estimate: feature 600 + agent 200 + perf 168–187 ≈ **968–987 / 1000**.
  The perf column is venue-sensitive (shared VM here vs the production cluster the reference
  medians were measured on), so the graded perf number will differ; conformance is venue-free.
- A real `git` client (2.43) was also driven against the forge by hand: init → push → clone,
  fast-forward push, branch create, annotated tag push, `--depth 1` shallow clone, and a
  non-fast-forward push correctly refused.

## Implemented

- **Lifecycle**: kit `main.ts` unchanged (bind ephemeral port, register, poll done, exit 0).
- **git smart HTTP**: v2 advertisement + ls-refs (peel/symrefs/unborn/ref-prefix), v2 fetch
  (acknowledgments/shallow-info/packfile sections, side-band-64k), v0 advertisement + fetch,
  receive-pack v0 (report-status, side-band-64k, delete-refs), fast-forward-only updates with
  per-ref `ok`/`ng non-fast-forward`, pack read with OFS/REF delta resolution, pack write,
  shallow depth/deepen with correct boundary reporting, have-negotiation that never re-sends
  held objects.
- **REST v3**: API root + meta, user/repos CRUD with Link-header pagination, branches,
  commits, tags, git refs, contents PUT/GET/DELETE as real commits (201/200/409 semantics),
  labels, issues (labels validated → 422, state/sort filters, comments), pull requests
  (create/list/get, files with line-diff counts, squash merge → 200/404/405), JSON errors with
  `message`, `X-GitHub-Request-Id` on every reply, 401 without the token, foreign owner → 404.
- **GraphQL v4**: parser/executor covering viewer, repository fields, issue/issues (states +
  CREATED_AT ordering + cursor pagination), pullRequest/pullRequests/files, mutations
  createIssue/closeIssue/createPullRequest/mergePullRequest/addComment, `node(id:)`,
  `__type` introspection for Issue/PullRequest/Repository/SearchType, batched operations
  (array body), unknown field → 200 + errors, unknown repository → `data.repository = null`.
- **MCP**: `server/discover` (2026-07-28, supportedVersions), `initialize` handshake revisions,
  tools/list (six tools, byte-identical across calls), tools/call for create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request on the REST store,
  -32601/-32602/-32700 semantics, 401 without Authorization.
- **Determinism**: all timestamps from `MAKEFUN_TRIAL_NOW` + tick counter; counter request
  ids; stable base64 global ids (never the bare databaseId).

## Not done / next steps

1. **GitHub account + public repo** (the user's step, in progress): submission requires a
   public GitHub repository owned by the entrant's account, created after 2026-11-14T06:30Z,
   with an OSI license (MIT `LICENSE` is in the tree). Push this directory, then submit
   `repo_url` + the head `commit_sha` + the transcript bundle via the kit CLI
   (`node cli/makefun.mjs bundle`, then the competition's submit flow) — at most 5/day, 10 total;
   the last submission before the deadline is the final entry.
2. **Re-grade after pushing**: run one practice submission to see the platform's own practice
   score (dev trials run on practice instance 0, the same instance graded locally here).
3. Optional perf hardening if the practice score's perf column disappoints: the clone workload
   showed the widest variance locally (33–45 points across runs).

## Known simplifications (accepted, suite-verified)

- Single-user forge: the token owner is the suite scenario's viewer (`adaiversen`, id 1000);
  there is no user/org management beyond that identity.
- Packs are written without delta compression (the suite's pack-deltas check only verifies
  deltas a server chooses to send; plain packs are valid and fast at this scale).
- GitHub URL fields in JSON shapes are built from the request's Host header; the suite checks
  data and statuses, not URL hosts.
