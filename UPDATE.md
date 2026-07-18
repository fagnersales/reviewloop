# Update reviewloop — agent playbook

You are an AI coding agent updating an existing reviewloop install to the
latest version. Follow this file top to bottom from the reviewloop repo root.

Safe by construction: everything user-specific lives in **gitignored** files
(`.env.local`, `worker/config.local.json`, `worker/solver.config.json`, logs,
pid files) — pulling new code never touches any of it.

## 1. Locate + sanity-check

Run from the reviewloop checkout (the repo whose `package.json` has
`"name": "reviewloop"`). Require a clean tree before pulling:

```bash
git status --porcelain    # tracked changes? stop and ask the user first
```

## 2. Fetch + preview what's new

The canonical remote is `upstream` if it exists (fork setup), else `origin`:

```bash
REMOTE=$(git remote | grep -qx upstream && echo upstream || echo origin)
git fetch "$REMOTE"
git log --oneline HEAD.."$REMOTE/master"
```

If that log is empty, report "already up to date" and stop. Otherwise
summarize the new commits to the user in a sentence or two before applying.

## 3. Apply

```bash
# plain clone:
git pull --ff-only "$REMOTE" master

# fork with local commits (--ff-only refused): merge instead
git merge "$REMOTE/master"
```

If a fork's merge conflicts, resolve with the user — their local changes win
on intent, upstream wins on mechanics.

```bash
npm install               # deps may have changed
npx convex dev --once     # push updated backend functions to their deployment
```

## 4. Restart the running pieces

Check nothing is mid-review before killing the worker:

```bash
npx convex run reviews:board    # anything in the "reviewing" bucket?
```

- **Nothing reviewing:** restart now (the `ps` guard skips a stale pid file
  from a crash/reboot instead of killing whatever process recycled the pid) —
  `pid=$(cat worker/worker.pid 2>/dev/null) && ps -p "$pid" -o command= | grep -q worker/index.mjs && kill "$pid";`
  `nohup node worker/index.mjs >> worker/worker.out 2>&1 < /dev/null & echo $! > worker/worker.pid`
- **A review is in flight:** tell the user; either wait for it, or restart
  anyway — a killed run is auto-requeued by the `requeue stale reviews` cron
  after ~25 min, nothing is lost.

The dashboard: if it runs via `npm run dev` (Vite), it hot-reloads the new
frontend by itself; restart it the same kill/nohup way (pid in
`worker/dashboard.pid`) only if it looks stale. If the solver
(`worker/solver.mjs`) is running, restart it too — same rule: check
`npx convex run solveTasks:board` for in-flight solves first, and never kill
one mid-build without asking.

## 5. Verify + report

```bash
CLOUD=$(grep -E '^VITE_CONVEX_URL=' .env.local | cut -d= -f2-)
curl -fsS "${CLOUD/.convex.cloud/.convex.site}/health"    # → {"ok":true} (backend only)
tail -5 worker/worker.out    # the worker itself: expect a fresh `worker "…" up; convex=…` line
```

Report to the user: what was updated (the commit summary from step 2), what
was restarted, and anything the changelog says they should do by hand.
