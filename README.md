# prr-console

Event-driven PR review. A GitHub webhook pushes `pull_request` events into a
standalone Convex deployment; a local worker subscribes over the Convex sync
websocket and reviews each PR the moment it opens or is pushed to — no polling.
For each review the worker clones the repo into a throwaway temp dir and runs
`claude -p` with the review instructions passed **inline**, so a watched repo
needs no local checkout and no `/pr-review` skill installed in it. A small
dashboard shows the live state: what's queued, what's **being verified** (with an
elapsed timer, since a review takes ~10 min), and what's been **verified** (with
the GitHub review link + confidence score).

This replaced the retired `prr` poll loop (the old `~/.local/bin/prr` +
`~/.pr-review-loop` gh-polling daemon, now removed).

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
  `reviews.ts` (enqueue/claim/finish/board/…), `controls.ts` (rescan), `crons.ts`
  (requeue crashed runs).
- `worker/index.mjs` — the long-lived subscriber that runs reviews. The watch
  list lives in Convex (managed from the dashboard); `worker/config.json` holds
  only host settings (model, concurrency, clone dir).
- `src/` — the dashboard.

## One-time setup

1. **Install + create the deployment** (interactive — opens a browser to log in
   and create a *new, separate* Convex project; do not reuse roblox-auto-delivery):

   ```bash
   cd /Users/fagnersales/prototype/prr-console
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
   gh api repos/fagnersales/roblox-auto-delivery/hooks \
     -f name=web -F active=true \
     -f 'events[]=pull_request' \
     -f config[url]="$SITE_URL/github/webhook" \
     -f config[content_type]=json \
     -f config[secret]="$SECRET"
   ```

   > The current `gh` token has `repo` but not `admin:repo_hook`. `repo` usually
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
# foreground (like `npm run locator`)
npm run worker

# background (survives the terminal, not a reboot)
nohup node worker/index.mjs >> worker/worker.out 2>&1 < /dev/null & echo $! > worker/worker.pid

kill "$(cat worker/worker.pid)"   # stop the background one
tail -f worker/worker.out          # worker log; per-PR run logs in worker/logs/
```

For auto-start on login/reboot, wrap it in a launchd agent (not set up by
default — mirrors how the locator is run manually).

## Verify end-to-end

- `GET $SITE_URL/health` → `{ "ok": true }`.
- Push a commit to an open PR (or open a throwaway one). Within seconds the board
  goes **Queued → Verifying (timer) → Verified** with a link to the posted review.
- `gh api repos/fagnersales/roblox-auto-delivery/hooks/<id>/deliveries` → `200`s.
- Re-deliver the same event from GitHub's webhook UI → no duplicate row (dedup by
  head SHA).
- Kill the worker mid-review → the `requeue stale reviews` cron flips it back to
  `queued` after ~25 min; restart → it re-claims.

## Waiting for a review (`node worker/await.mjs`)

`worker/await.mjs` is a blocking companion to the worker: it subscribes to the
**one** `reviews` row for a PR's *head commit* and exits the moment that row goes
**reviewed** / **failed** — no polling, no human in the relay. It's meant to be
run in the background by an automated caller (Claude Code) right after pushing.
Invoke it as `node worker/await.mjs <pr>` (or `npm run await -- <pr> …`); the
installed bin alias is `prr-await <pr>`.

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
| `1` | usage / connection error, or the repo isn't watched by prr-console (self-heal got `unwatched`) |

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
~60s. `doEnqueue` is idempotent, so this is safe even if a late webhook or the
reconcile also fires (it returns `duplicate`). If the repo isn't watched, the
self-heal enqueue reports `unwatched`; since no review will ever be queued,
`await` says so explicitly and **gives up at once (exit 1)** rather than blocking
out the full timeout — so an unwatched repo now surfaces in ~60s instead of as an
ambiguous `124` after `--timeout`.

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

Override any field in `worker/config.local.json` (gitignored), or via env
(`PRR_CONVEX_URL`, `CLAUDE_BIN`, `PRR_CLONE_DIR`).

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
