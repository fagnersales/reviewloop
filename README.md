# reviewloop.sh

**Homepage:** <https://reviewloop.fagner.ink>

Event-driven PR review. A GitHub webhook pushes `pull_request` events into a
standalone Convex deployment; a local worker subscribes over the Convex sync
websocket and reviews each PR the moment it opens or is pushed to — no polling.
For each review the worker clones the repo into a throwaway temp dir and runs
`claude -p` with the review instructions passed **inline**, so a watched repo
needs no local checkout and no `/pr-review` skill installed in it. A small
dashboard shows the live state: what's queued, what's **being verified** (with an
elapsed timer, since a review takes ~10 min), and what's been **verified** (with
the GitHub review link + confidence score).

## Install (one prompt)

reviewloop is installed *by your coding agent*. Paste this into Claude Code,
Codex, or any agent that can fetch a URL and run commands:

> Fetch https://raw.githubusercontent.com/fagnersales/reviewloop/master/INSTALL.md and follow it to install reviewloop for me.

The playbook ([INSTALL.md](INSTALL.md)) checks prerequisites, walks you
through creating your own free Convex project (guiding from zero if you've
never used Convex), starts the worker + dashboard, watches your first repo,
and teaches your agents to block on reviews via `reviewloop-await`. It's
idempotent — re-running it completes a partial install.

**Updating:** tell your agent *"Open UPDATE.md in my reviewloop folder and
follow it"* (in Claude Code, `/update-reviewloop`). All local state is
gitignored, so an update is a clean pull + `npx convex dev --once` + worker
restart — see [UPDATE.md](UPDATE.md). Forks stay updatable too: clone your
fork, keep this repo as the `upstream` remote, and the same playbook merges
new features in.

**Engine note:** reviews are performed by the Claude Code CLI (`claude -p`),
so that's a hard prerequisite even if you drive the install from another
agent. A `codex exec` engine adapter is a welcome contribution.

This replaced the retired `prr` poll loop (the old `~/.local/bin/prr` +
`~/.pr-review-loop` gh-polling daemon, now removed).

Formerly named **prr-console**. The pre-rename `prr-await`/`prr-ack`/`prr-suggest`
bin aliases and `PRR_*` env vars are still honored for anything not yet migrated.

```
GitHub PR event ──HTTPS──▶ Convex /github/webhook  (verify X-Hub-Signature-256)
                                  │ enqueue (dedup by repo+PR+headSha)
                                  ▼
                           reviews table  ◀── finish(reviewUrl, score, P-counts)
                                  │ websocket (reactive)            ▲
                ┌─────────────────┴───────────────┐                │
                ▼                                  ▼                │
        worker/index.mjs                    Dashboard (Vite+React)  │
        subscribe→claim→`claude -p`──────────────────────────────┘
        in a throwaway repo clone          live board + timers
```

## Layout

- `convex/` — backend. `schema.ts`, `http.ts` (`/github/webhook`, `/health`),
  `reviews.ts` (enqueue/claim/finish/board/…), `suggestedIssues.ts` (the
  PR-follow-ups inbox), `solveTasks.ts` (the autonomous solver queue),
  `controls.ts` (rescan), `crons.ts` (requeue crashed runs).
- `worker/index.mjs` — the long-lived subscriber that runs **reviews**. The watch
  list lives in Convex (managed from the dashboard); `worker/config.json` holds
  only host settings (model, concurrency, clone dir).
- `worker/solver.mjs` — a separate long-lived subscriber that runs **solves**:
  spawns `/pr-feature` against a configured checkout to build a `ready-for-agent`
  issue and open a PR. Its checkout registry is `worker/solver.config.json`
  (host-specific, gitignored). See [The autonomous solver](#the-autonomous-solver-issue--pr).
- `src/` — the dashboard.
- `site/` — the public homepage (static, deployed to Vercel; no build step).

## Manual setup

What [INSTALL.md](INSTALL.md) automates, spelled out:

1. **Install + create the deployment** (interactive — opens a browser to log in
   and create a **new** Convex project):

   ```bash
   cd <your reviewloop checkout>
   npm install
   npx convex dev          # creates the deployment, writes .env.local, pushes functions
   ```

   Leave `npx convex dev` running (or `npx convex dev --once` to just push).

2. **Set the webhook secret** (any random string; you'll reuse it on the webhook):

   ```bash
   SECRET=$(openssl rand -hex 24)
   npx convex env set GITHUB_WEBHOOK_SECRET "$SECRET"
   ```

3. **Create the GitHub webhook** pointing at the Convex *site* URL (the
   `.convex.site` one — see `npx convex dashboard` ▸ Settings ▸ URL & Deploy Key,
   or it's `VITE_CONVEX_URL` with `.cloud`→`.site`):

   ```bash
   SITE_URL="https://<your-deployment>.convex.site"
   gh api repos/<owner/name>/hooks \
     -f name=web -F active=true \
     -f 'events[]=pull_request' \
     -f config[url]="$SITE_URL/github/webhook" \
     -f config[content_type]=json \
     -f config[secret]="$SECRET"
   ```

   > Your `gh` token may have `repo` but not `admin:repo_hook`. `repo` usually
   > suffices; if GitHub 403s, run `gh auth refresh -s admin:repo_hook` and retry,
   > or add it manually in **repo Settings ▸ Webhooks ▸ Add webhook** (payload URL
   > `$SITE_URL/github/webhook`, content type `application/json`, the same secret,
   > "Let me select… → Pull requests").

4. **Run it:**

   ```bash
   npm run dev       # dashboard at http://localhost:5180
   npm run worker    # the subscriber, in the foreground (Ctrl-C to stop)
   ```

## Running the worker

The worker is just a long-lived Node subscriber (`worker/index.mjs`). Two ways:

```bash
# foreground
npm run worker

# background (survives the terminal, not a reboot)
nohup node worker/index.mjs >> worker/worker.out 2>&1 < /dev/null & echo $! > worker/worker.pid

# stop the background one (the ps guard skips a stale pid file left by a
# crash/reboot, which could otherwise point at an unrelated recycled pid)
pid=$(cat worker/worker.pid) && ps -p "$pid" -o command= | grep -q worker/index.mjs && kill "$pid"

tail -f worker/worker.out          # worker log (UTC timestamps); per-PR run logs in worker/logs/
```

For auto-start on login/reboot, wrap it in a launchd/systemd agent (not set
up by default).

## The autonomous solver (issue → PR)

The review worker reviews PRs. The **solver** worker (`worker/solver.mjs`) closes
the loop the other way: when a GitHub issue carries the **`ready-for-agent`** label,
it spawns an autonomous `claude -p "/pr-feature …"` run that **builds the feature
and opens a PR** (`Closes #N`). That PR is then reviewed by the review half *for
free*, auto-fixed for a few rounds, and **left for a human to merge** — the solver
**never merges**.

```
issue labelled ready-for-agent ──issues webhook / reconcile──▶ solveTasks (Convex)
        │ solver subscribes, claims
        ▼
  worker/solver.mjs ──spawns──▶ claude -p "/pr-feature solve #N"  (cwd = configured checkout)
        │                            │ EnterWorktree → build → open PR (Closes #N)
        │                            │ → reviewloop-await loop → auto-fix N rounds → STOP
        ▼                            ▼
  mark task pr-opened          PR reviewed for FREE by the review half
  (records PR # for lineage)   (pull_request webhook → reviews table → review worker)
        │
        ▼  (human merges — solver NEVER merges; the merge webhook flips the task → done)
```

The elegance: the solver does **not** reimplement build/review/fix. The global
`pr-feature` skill already does all of it (worktree → build → open PR → `reviewloop-await`
loop → auto-fix → stop clean). The solver just: find a ready-for-agent issue → claim
→ spawn `pr-feature` in the right folder → capture the PR → clean up.

**Why a separate process + a local checkout (not the review worker's throwaway
clone):** *building* needs what git does not carry — `.env.local` (secrets, the live
backend URL), `node_modules`, build caches — so a solve must run in a **real,
configured local checkout**. Paths are host-specific, so the repo→checkout registry
is local config (`worker/solver.config.json`), never Convex. A long solve (tens of
minutes to hours) also gets its own process so it never starves the fast reviews.

### Two human gates protect the cascade

Nothing auto-builds without two deliberate human decisions upstream: a human **opens**
an agent-proposed follow-up (or files an issue by hand), then **promotes** it to
`ready-for-agent`. Only then does the solver act. The label is the single trigger —
so manually-triaged issues work too, not just agent-proposed ones.

### The issue label lifecycle

`ready-for-agent` means **only "waiting, claimable"** — so the solver swaps the
issue's state-role label as it works, and nothing else (another host's solver, a
triage agent, a human browsing the label) can pick up an in-flight issue:

```
ready-for-agent ──claim──▶ agent-in-progress ──PR opened──▶ ready-for-human
                                   └─────────────failed─────▶ agent-failed
```

- **claim → `agent-in-progress`** the instant the solver commits to building it
  (after the checkout validates, so a host that *can't* build it never grabs the
  label). It's now off the `ready-for-agent` pool.
- **PR opened → `ready-for-human`** — the agent's done; a human reviews/merges the
  PR (the PR's `Closes #N` closes the issue on merge).
- **failed → `agent-failed`** (a distinct state, plus a stall comment). The reconcile
  keys on `ready-for-agent`, so a failed solve **does not auto-retry** an expensive
  build — re-label it `ready-for-agent` to retry, or take it over by hand.

The two `agent-*` labels are solver-set lifecycle states (not part of the human
triage picker). The `claim` itself is also guarded server-side by the atomic Convex
`solveTasks.claim`; the label swap is what makes the *GitHub* view honest too.

### Setup

1. **Enable the `Issues` event** on the repo webhook (the one-time webhook in
   step 3 only subscribed to *Pull requests*). Add `-f 'events[]=issues'` when
   creating it, or tick **Issues** in repo Settings ▸ Webhooks. *Optional* — the
   solver's reconcile (`gh issue list --label ready-for-agent`) catches labels even
   without the webhook; the webhook just makes it instant.

2. **Register a checkout per solvable repo.** Copy the template and fill in the
   map (paths are host-specific, so the file is gitignored):

   ```bash
   cp worker/solver.config.example.json worker/solver.config.json
   ```

   Use **dedicated, solver-owned** checkouts — not your personal clones. The
   `pr-feature` worktree symlinks `node_modules` back to the parent, so a solve that
   runs `npm install` would mutate *your* deps, and stale worktrees would litter a
   repo you actively use. One-time per repo:

   ```bash
   gh repo clone <owner/name> ~/solver-checkouts/<name>
   cd ~/solver-checkouts/<name> && npm install && cp <your-clone>/.env.local .env.local
   ```

   Then add `"owner/name": "~/solver-checkouts/<name>"` under `checkouts`. A
   `ready-for-agent` issue on a **watched** repo with **no** registered checkout is
   claimed and **failed with a clear reason** (never silently stalled) — two gates:
   Convex `watchedRepos` = "in the system", the checkout registry = "solvable on
   this host".

3. **Run it** (a separate process from the review worker):

   ```bash
   npm run solver
   # or background: nohup node worker/solver.mjs >> worker/solver.out 2>&1 < /dev/null &
   ```

   At startup it validates every configured checkout (path exists, is a git repo,
   `origin` matches the mapped slug; warns on missing `.env.local`/`node_modules`)
   and sweeps any stale `solve/issue-*` worktrees a crash left behind.

### Config (`worker/solver.config.json`)

| key | meaning |
| --- | --- |
| `checkouts` | **the registry** — `{ "owner/name": "/path" }`; `~` expands, slugs match case-insensitively |
| `convexUrl` | deployment URL; empty = read `VITE_CONVEX_URL` from `.env.local` |
| `model` | model for the `claude -p` solve (default `opus`) |
| `concurrency` | max simultaneous solves (default **1** — serial; building concurrently risks port/`npm install` collisions) |
| `solveTimeoutMin` | kill a solve after this many minutes (default 180 — it covers the whole build + internal review/auto-fix loop) |
| `maxFixRounds` | cap the internal auto-fix rounds (default 3) before stopping with the PR open |
| `fallbackReconcileMin` | slow `gh issue list` safety reconcile; `0` to disable (default 20) |

Override the checkout map via the `REVIEWLOOP_SOLVER_CHECKOUTS` env var (JSON); other env:
`REVIEWLOOP_CONVEX_URL`, `CLAUDE_BIN`. The solve task lifecycle is
`queued → solving → pr-opened → done | failed` (the `pull_request` merge webhook
flips `pr-opened → done`, closing the issue → solve → PR lineage). Every autonomous
spawn sets `REVIEWLOOP_UNATTENDED=1`, the contract that tells `pr-feature` it's headless.

## Verify end-to-end

- `GET $SITE_URL/health` → `{ "ok": true }`. This proves the **Convex backend**
  only — the local worker is a separate process. Worker liveness = its pid is
  alive and `worker/worker.out` shows the `worker "…" up; convex=…` line.
- Push a commit to an open PR (or open a throwaway one). Within seconds the board
  goes **Queued → Verifying (timer) → Verified** with a link to the posted review.
- `gh api repos/<owner/name>/hooks/<id>/deliveries` → `200`s.
- Re-deliver the same event from GitHub's webhook UI → no duplicate row (dedup by
  head SHA).
- Kill the worker mid-review → the `requeue stale reviews` cron flips it back to
  `queued` after ~25 min; restart → it re-claims.
- **Solver:** with `npm run solver` running and a checkout registered for a watched
  repo, label a throwaway issue `ready-for-agent`. Within seconds the solve goes
  **queued → solving**; the agent opens a PR (`Closes #N`) which the review half then
  picks up, and the task reaches **pr-opened** with the PR number recorded. Merge that
  PR → the `pull_request` webhook flips the task to **done**. (No checkout for the
  repo → the task fails fast with `no solver checkout registered…`.)

## Waiting for a review (`node worker/await.mjs`)

`worker/await.mjs` is a blocking companion to the worker: it subscribes to the
**one** `reviews` row for a PR's *head commit* and exits the moment that row goes
**reviewed** / **failed** — no polling, no human in the relay. It's meant to be
run in the background by an automated caller (Claude Code) right after pushing.
Invoke it as `node worker/await.mjs <pr>` (or `npm run await -- <pr> …`); the
installed bin alias is `reviewloop-await <pr>`.

```
git push ──▶ webhook ──▶ reviews row (queued→reviewing→reviewed)
                              │ websocket (reactive)
                              ▼
                     worker/await.mjs <pr>
                     blocks on the row for THIS head SHA,
                     prints result JSON to stdout, exits with a verdict code
```

```bash
node worker/await.mjs <pr> --repo owner/name
# defaults: --repo from `gh repo view`, --head from `gh pr view <pr>`,
#           --timeout 1800, heartbeat on stderr (--quiet to mute).
# stdout carries the result JSON only on a terminal review outcome (exit 0/2/3/124);
# on exit 1 (usage / connection / query error) nothing is printed to stdout. `--json`
# is accepted for clarity but is the default behavior — there is no `--no-json` opposite flag.
```

Head-SHA keyed, so it waits for the review of *this* push (a re-push enqueues a
fresh row keyed by the new SHA). It prints a status heartbeat to **stderr** and
the result JSON to **stdout**:

```json
{ "status": "reviewed", "repo": "owner/name", "prNumber": 42, "headSha": "…",
  "reviewUrl": "…", "confidence": 4, "reviewEffort": 3,
  "p0": 0, "p1": 1, "p2": 2, "error": null, "finishedAt": 1718800000000 }
```

(`error` carries the failure reason on a `failed` row; `null` otherwise.)

Exit codes (so a caller can branch without parsing the JSON):

| code | meaning |
| --- | --- |
| `0` | reviewed, no P0/P1 |
| `2` | reviewed with blockers — `p0 \|\| p1 > 0`, **or** the counts were unparseable (`null`); either way, read the review |
| `3` | failed (`error` in the JSON carries the reason) — last-observed state, not final |
| `124` | timed out (prints last-known state) |
| `1` | usage / connection error, or the repo isn't watched by reviewloop (self-heal got `unwatched`) |

Exit `3` is the *last-observed* state, not a final give-up: the worker's fallback
reconcile (~`fallbackReconcileMin`, default 30 min) re-enqueues open PRs whose only
rows for the head SHA are `failed` (a fresh `queued` row), so a caller treating exit
`3` as retriable can simply re-run `await` to catch the next attempt.

**Branch on the exit code, not `.status`.** On `--timeout` the JSON `status`
reflects the last-known state (e.g. `"reviewing"`), not `"timeout"` — only the
exit code (`124`) tells you it gave up. And if a PR is closed while its review is
still `queued`, the row is removed and `await` blocks until `--timeout` (exit
`124`) rather than exiting early.

If no row appears within ~60s — the symptom of a dropped `synchronize` webhook
delivery — `await` **self-heals**: it enqueues the review itself via the same
idempotent `reviews.enqueueMissing` path the worker's reconcile uses, collapsing
the recovery latency from up to the full fallback-reconcile interval (~30 min) to
~60s. It only heals **open, non-draft** PRs — mirroring the webhook and reconcile,
which both skip drafts/closed PRs — since for those "no row" is the expected state,
not a dropped delivery (it keeps waiting instead). `doEnqueue` is idempotent, so
this is safe even if a late webhook or the reconcile also fires (it returns
`duplicate`). If the repo isn't watched, the
self-heal enqueue reports `unwatched`; since no review will ever be queued,
`await` says so explicitly and **gives up at once (exit 1)** rather than blocking
out the full timeout — so an unwatched repo now surfaces in ~60s instead of as an
ambiguous `124` after `--timeout`.

## Ambient review-in-progress indicator (optional)

A blocking `await` is invisible from the outside: the agent's turn ends but a
background process is still waiting, so the pane looks idle when it isn't.
`await.mjs` can drive an external indicator to fix that — entirely opt-in, and a
clean no-op for anyone who doesn't want one (no cmux or anything else required).

If `REVIEWLOOP_AWAIT_HOOK` (or `awaitHook` in config) names an executable, `await` calls
it on two lifecycle edges:

```
<hook> start <waiterPid> <repo> <pr> <sha>   # when it begins blocking
<hook> end   <exitCode>  <repo> <pr> <sha>   # when it exits (any graceful path)
```

The contract is deliberately generic — `await.mjs` knows nothing about the
consumer. The **exit code carries the verdict** (`0` clean · `2` blockers · `3`
failed · `124` timeout · `1` error), so the adapter decides how to present it. A
failing or slow hook never affects the verdict (errors are swallowed, 3s cap).
The `end` edge fires on every graceful exit (`settle` / timeout / `onQueryError` /
SIGINT / SIGTERM); it does **not** fire on SIGKILL — `waiterPid` is handed to the
consumer so it can reap a hard-killed waiter itself.

Forkers wire up their own indicator (tmux statusline, desktop notification, Slack
ping) by dropping a script and pointing `REVIEWLOOP_AWAIT_HOOK` at it. One is bundled:

- **cmux** — `integrations/cmux-ring.sh` lights the review ring on the cmux pane:
  orange while waiting, green on a clean pass, red on blockers, amber on a review
  error, grey on timeout. It no-ops outside cmux. Enable it with
  `export REVIEWLOOP_AWAIT_HOOK="$PWD/integrations/cmux-ring.sh"`. It self-targets the
  workspace and the right cmux app instance via the `CMUX_WORKSPACE_ID` /
  `CMUX_SOCKET_PATH` cmux injects into the pane (inherited by the background
  waiter), so there's nothing else to configure; cmux's stale-PID sweep uses the
  forwarded `waiterPid` to clear the ring if the waiter is SIGKILLed.

## Acknowledging a review (`node worker/ack.mjs`)

A posted review leaves the PR in one of two states the console can't tell apart on
its own: **Awaiting agent** (reviewed, has blockers, nobody's on it) vs **In
progress** (an agent has picked it up). The console can't observe the latter —
an agent has started but hasn't pushed a commit yet — so the agent says so
explicitly by **acking** the review.

`worker/ack.mjs` is the companion to `await.mjs`: a fix agent runs it once it picks
up a review it's about to fix. It stamps the `reviews` row (`ackedAt`/`ackedBy`),
which flips the board badge from **Awaiting agent** to **In progress** and adds an
"Agent picked it up" step to the review-loop timeline. Invoke it as
`node worker/ack.mjs <pr>` (or `npm run ack -- <pr> …`); the installed bin alias is
`reviewloop-ack <pr>`. The natural pairing is **await → ack**:

```bash
reviewloop-await <pr> --repo owner/name --head <sha>   # block until the review lands
# … it came back with blockers (exit 2); you're going to fix them:
reviewloop-ack   <pr> --repo owner/name --head <sha>   # tell the board you're on it
```

```bash
node worker/ack.mjs <pr> --repo owner/name
# defaults: --repo from `gh repo view`; --head = the PR's latest pass when omitted;
#           --by = $USER@$HOST. --clear releases a prior ack (you bailed).
```

It's one-shot: it calls the `reviews.ack` mutation and prints the result JSON to
stdout. Only a still-open **reviewed** pass is ackable (nothing to pick up on a
queued/reviewing/failed row or a merged/closed PR).

| code | meaning |
| --- | --- |
| `0` | ack recorded (or, with `--clear`, released) |
| `2` | nothing to ack — no reviewed pass for this PR/SHA yet, or the PR is merged/closed |
| `1` | usage / connection error |

The state is kept honest automatically: a `clearStaleAcks` cron drops an ack left
on a still-current reviewed pass with no fix pushed within ~90 min, so an abandoned
**In progress** reverts to **Awaiting agent**. An ack on a pass a later commit has
already superseded is kept as history.

## Config (`worker/config.json`)

The **watch list is not here** — repos are managed from the dashboard and stored
in Convex (`watchedRepos`); the worker subscribes to it. `worker/config.json`
holds only host/runtime settings:

| key | meaning |
| --- | --- |
| `convexUrl` | deployment URL; empty = read `VITE_CONVEX_URL` from `.env.local` |
| `model` | model for `claude -p` (default `opus`) |
| `concurrency` | max simultaneous reviews (default 3) |
| `reviewTimeoutMin` | kill a run after this many minutes (default 25) |
| `fallbackReconcileMin` | slow `gh`-based safety reconcile; `0` to disable (default 30) |
| `cloneDir` | where per-review throwaway clones go; empty = OS temp dir |
| `awaitHook` | optional executable `await.mjs` runs on its start/end edges to drive an ambient indicator; empty = none (see [Ambient review-in-progress indicator](#ambient-review-in-progress-indicator-optional)) |

Override any field in `worker/config.local.json` (gitignored), or via env
(`REVIEWLOOP_CONVEX_URL`, `CLAUDE_BIN`, `REVIEWLOOP_CLONE_DIR`, `REVIEWLOOP_AWAIT_HOOK`).

### Managing watched repos

Add/remove repos from the dashboard (the `+` / hover-`×` controls on the repo
filter). The watch list is **authoritative** — both the webhook enqueue and the
worker reconcile gate on it (`doEnqueue` in `convex/reviews.ts`):

- **Add:** the repo is reconciled **immediately** — its open, non-draft PRs are
  queued at once, without waiting for the fallback timer. New pushes are reviewed
  via the GitHub webhook (one-time setup, step 3); the reconcile is the safety net
  that also catches repos added before their webhook, or events missed while the
  worker was down.
- **Remove:** new reviews **stop** — an unwatched repo's webhook deliveries are
  ignored (logged as `unwatched`) and the reconcile skips it. Reviews already
  queued or running still finish. The GitHub webhook can stay configured, so
  add/remove here never requires touching GitHub.

A repo only gets auto-cloned and reviewed (under `claude --permission-mode
bypassPermissions`) while it's on this list, so keep it to repos you trust.

## License

MIT — see [LICENSE](LICENSE).
