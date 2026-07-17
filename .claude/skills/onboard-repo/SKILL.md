---
name: onboard-repo
description:
  Configure (onboard) a new repo into reviewloop so it is reviewed and, optionally,
  autonomously solvable — add it to the Convex watch list, set up the GitHub webhook
  (pull_request + issues), and register a dedicated solver checkout. Idempotent:
  re-running only fills in what's missing. Use when the user wants to "configure a
  new project", "onboard / add / watch a repo", "set up reviews for owner/name", or
  "make the solver build issues in owner/name".
argument-hint: "<owner/name> [--review-only]"
---

# Onboard a repo into reviewloop

Make a GitHub repo fully wired into this console: **reviewed** (the review worker
picks up its PRs) and, unless `--review-only`, **solvable** (the solver builds its
`ready-for-agent` issues into PRs). The work is two independent layers:

| Layer | Where | Reactive? |
|---|---|---|
| **In the system** — watch list + GitHub webhook | Convex `watchedRepos` + the repo's webhook | watch list yes; webhook is a one-time GitHub resource |
| **Solvable on this host** — a dedicated checkout | `worker/solver.config.json` (local, gitignored) | **no** — read once at solver startup, so it needs a restart |

A repo needs the first layer to be reviewed, and **both** layers before the solver
will build for it. The whole skill is **idempotent** — every step checks current
state first, so re-running on a partially-configured repo just completes it.

## Where to run

All `npx convex …`, `.env.local` reads, and `worker/solver.config.json` edits run
from the **reviewloop repo root** — the directory this skill lives in
(`/Users/fagnersales/prototype/reviewloop`). `cd` there first (or use absolute
paths). The *target* repo (`owner/name`) is only ever touched through `gh --repo`
and the clone in step 3 — never checked out into reviewloop.

## Prerequisites

- `gh` authenticated (`gh auth status`). Webhook creation needs the
  `admin:repo_hook` scope — `repo` often suffices, but if a `gh api … /hooks` call
  403s, run `gh auth refresh -s admin:repo_hook` and retry (or fall back to the
  manual GitHub UI, below).
- The reviewloop Convex deployment is up and `.env.local` has `VITE_CONVEX_URL`.

## Process

### 1. Resolve inputs

- **Repo slug** (`owner/name`): from the argument, else ask. Validate it looks like
  `owner/name` and exists: `gh repo view <slug> --json nameWithOwner,isPrivate`.
- **Mode**: `--review-only` ⇒ skip the solver checkout (steps 3–4). Otherwise this
  is **review + solve**. If the user didn't say which and it's ambiguous, ask once:
  *"review-only, or also register a solver checkout so it auto-builds
  `ready-for-agent` issues?"* — the checkout is the heavier, host-specific part.
- Resolve the deployment URLs once:

  ```bash
  CLOUD=$(grep -E '^VITE_CONVEX_URL=' .env.local | cut -d= -f2-)
  SITE=${CLOUD/.convex.cloud/.convex.site}     # e.g. https://<dep>.convex.site
  ```

### 2. Layer 1 — put it in the system (Convex + webhook)

**2a. Watch list (cheap, reversible — just do it).** Check, then add:

```bash
npx convex run repos:list        # array of watched slugs
npx convex run repos:add '{"repo":"owner/name"}'   # → "added" | "exists" | "invalid" | "full"
```

`exists` is success (already watched). This is **reactive**: the running worker and
solver see it over the websocket immediately — no restart. (Adding it here is also
what gates reviews *and* solves — `doEnqueue` rejects unwatched repos.)

**2b. Webhook (outward — check before creating).** List the repo's hooks and look
for one already pointing at this deployment:

```bash
gh api repos/owner/name/hooks \
  --jq '.[] | select((.config.url // "") | endswith("/github/webhook")) | {id, events}'
```

- **A hook already points at `$SITE/github/webhook`:** ensure its `events` include
  **both** `pull_request` and `issues` (the latter is the solver's trigger). If
  `issues` is missing, patch it — don't create a second hook:

  ```bash
  gh api -X PATCH repos/owner/name/hooks/<id> \
    -f 'events[]=pull_request' -f 'events[]=issues'
  ```

- **No hook yet:** create one, reusing the deployment's shared secret. Tell the user
  you're about to create a GitHub webhook on their repo, then:

  ```bash
  SECRET=$(npx convex env get GITHUB_WEBHOOK_SECRET)
  gh api repos/owner/name/hooks \
    -f name=web -F active=true \
    -f 'events[]=pull_request' \
    -f 'events[]=issues' \
    -f config[url]="$SITE/github/webhook" \
    -f config[content_type]=json \
    -f config[secret]="$SECRET"
  ```

  If this 403s on scope: `gh auth refresh -s admin:repo_hook` then retry, or have the
  user add it in **repo Settings ▸ Webhooks ▸ Add webhook** (payload `$SITE/github/webhook`,
  content type `application/json`, that secret, events **Pull requests** + **Issues**).

> The webhook only makes triggers *instant*. Both workers also reconcile via `gh`
> (`pr list` / `issue list --label ready-for-agent`) on their fallback interval, so
> a repo is functional even if you skip the webhook — it's just not snappy. If the
> user can't/won't create the webhook, note that and continue; don't treat it as fatal.

**If `--review-only`:** skip to step 5.

### 3. Layer 2 — make it solvable (dedicated checkout)

The solver builds in a **real** checkout because a build needs gitignored artifacts
git doesn't carry (`.env.local`, `node_modules`, caches). Use a **dedicated**,
solver-owned clone — never the user's personal one (the pr-feature worktree symlinks
`node_modules` back to the parent, so a solve running `npm install` would mutate
their deps, and stale worktrees would litter a repo they use).

```bash
DEST=~/solver-checkouts/<name>            # pick a dedicated path; confirm with the user
gh repo clone owner/name "$DEST"
```

Then make it **buildable** — do what the repo needs, mirroring its own README/setup:

- Node project: `cd "$DEST" && npm install` (or pnpm/yarn per its lockfile).
- If the build needs gitignored secrets/a live backend URL, copy them from the
  user's existing clone: `cp <their-clone>/.env.local "$DEST"/.env.local`. Ask where
  their clone is if you don't know; **don't invent secret values.**

This step varies per repo — if you're unsure what it needs to build, ask rather than
guessing. A checkout that can't build will make every solve fail.

### 4. Register the checkout + restart the solver

**4a. Register it** in `worker/solver.config.json` (create it from
`worker/solver.config.example.json` if absent). Add/merge the mapping under
`checkouts`, keep the rest, and keep it valid JSON:

```jsonc
{
  "checkouts": {
    "owner/name": "~/solver-checkouts/<name>"   // ~ expands; slugs case-insensitive
  }
}
```

Sanity-check the path before declaring success (these mirror the solver's own
startup validation — catch a bad entry now, not at solve time):

```bash
git -C "$DEST" rev-parse --git-dir >/dev/null   # is a git repo
git -C "$DEST" remote get-url origin            # origin must resolve to owner/name
test -f "$DEST/.env.local" || echo "warn: no .env.local (a build needing secrets may fail)"
test -d "$DEST/node_modules" || echo "warn: no node_modules (run the install step)"
```

**4b. Restart the solver — this is the gotcha.** `solver.config.json` is read **once
at startup** (no file-watch), so the new checkout only takes effect after a restart.
Check what's running and act accordingly — **don't blindly kill a solve in flight:**

```bash
pgrep -fl "worker/solver.mjs"                   # is a solver running?
npx convex run solveTasks:board   # any in-flight solves? (the "solving" bucket)
```

- **Not running:** offer to start one in the background:
  `nohup node worker/solver.mjs >> worker/solver.out 2>&1 < /dev/null & echo $! > worker/solver.pid`
- **Running, no solve in flight:** restart it (kill the old pid / Ctrl-C, then start
  as above). If it's a foreground `npm run solver` in another terminal, you can't
  reach it — tell the user to restart it.
- **Running with a solve in flight:** do **not** restart — tell the user the new
  checkout takes effect after their current solve finishes and they restart, or they
  can restart now to interrupt it. Let them choose.

### 5. Verify + report

Confirm what actually took:

```bash
curl -fsS "$SITE/health"                         # → {"ok":true}
npx convex run repos:list          # includes owner/name
gh api repos/owner/name/hooks --jq '.[].events'  # includes pull_request + issues (if a hook was set)
```

Then report concisely:

- ✅ **Reviewed:** watched + webhook (or "via reconcile, no webhook"). New PRs are
  reviewed automatically; `reviewloop-await`/`reviewloop-ack` work against it.
- ✅ **Solvable** (unless review-only): checkout registered at `<path>`, solver
  (re)started — or the restart the user still needs to do.
- **To trigger a solve:** label any open issue **`ready-for-agent`** (a human gate —
  via the triage flow or `gh issue edit <n> --repo owner/name --add-label ready-for-agent`).
  The solver claims it, spawns `/pr-feature` in the checkout, opens a PR (`Closes #N`),
  and the review half reviews it. **A human merges — the solver never does.**

## Notes & guardrails

- **Idempotent throughout** — safe to re-run to finish a half-configured repo or to
  flip a review-only repo into solvable later (just do steps 3–5).
- **Outward actions are the webhook and the clone.** Do the cheap, reactive watch-list
  add immediately; give a one-line heads-up before creating the GitHub webhook and
  before cloning, and report what you did. Everything else is local/reversible.
- **Don't fabricate secrets or guess a repo's build.** When `.env.local` contents or
  the build command are unknown, ask — a silently-misconfigured checkout fails every
  solve with a confusing error.
- **Trust = scope.** A registered checkout runs an autonomous `claude -p` under
  `bypassPermissions` against real secrets. Only register repos the user trusts the
  agent to build in; the two human gates upstream (open the issue, promote it to
  `ready-for-agent`) are the cascade brakes — never add an auto-promote.
