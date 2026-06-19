# prr-console

Event-driven PR review. A GitHub webhook pushes `pull_request` events into a
standalone Convex deployment; a local worker subscribes over the Convex sync
websocket and fires `claude -p '/pr-review N'` the moment a PR opens or is pushed
to — no polling. A small dashboard shows the live state: what's queued, what's
**being verified** (with an elapsed timer, since a review takes ~10 min), and
what's been **verified** (with the GitHub review link + confidence score).

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
        in the target repo's cwd           live board + timers
```

## Layout

- `convex/` — backend. `schema.ts`, `http.ts` (`/github/webhook`, `/health`),
  `reviews.ts` (enqueue/claim/finish/board/…), `controls.ts` (rescan), `crons.ts`
  (requeue crashed runs).
- `worker/index.mjs` — the long-lived subscriber that runs reviews. Config in
  `worker/config.json` (repos→workdirs, model, concurrency).
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

## Config (`worker/config.json`)

| key | meaning |
| --- | --- |
| `convexUrl` | deployment URL; empty = read `VITE_CONVEX_URL` from `.env.local` |
| `repos[]` | `{ repo: "owner/name", workdir: "/abs/path" }` — where to run `claude -p` |
| `model` | model for `claude -p` (default `opus`) |
| `concurrency` | max simultaneous reviews (default 3) |
| `reviewTimeoutMin` | kill a run after this many minutes (default 25) |
| `fallbackReconcileMin` | slow `gh`-based safety reconcile; `0` to disable (default 30) |

Override any field in `worker/config.local.json` (gitignored).
