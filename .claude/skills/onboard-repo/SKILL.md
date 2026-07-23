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
| **Solvable on this host** — a dedicated checkout | the clone on disk + a Convex `solverCheckouts` row (keyed by hostname) | **yes** — the solver subscribes, so no restart |

A repo needs the first layer to be reviewed, and **both** layers before the solver
will build for it. The whole skill is **idempotent** — every step checks current
state first, so re-running on a partially-configured repo just completes it.

## Where to run

All `npx convex …` calls and `.env.local` reads run from the **reviewloop repo
root** — the checkout this skill lives in (three directories up from this
SKILL.md). `cd` there first (or use absolute paths). The *target* repo
(`owner/name`) is only ever touched through `gh --repo` and the clone in step 3 —
never checked out into reviewloop.

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

### 3. Layer 2 — make it solvable (register; the solver provisions)

The solver builds in a **real** checkout because a build needs gitignored artifacts
git doesn't carry (`.env.local`, `node_modules`, caches). Registering is now the
whole step: the solver **provisions the checkout itself** — clones a dedicated copy
via `gh`, then runs a one-shot setup agent that installs deps, finds the user's
existing clone of the same repo (matched by `git remote origin`) and copies its
gitignored env files (never inventing secret values), and follows the repo's README
setup. You do NOT clone or install anything by hand.

Register under **this machine's** hostname (must match what the solver reports,
suffix included). Omitting a custom path is fine — the solver convention is
`~/solver-checkouts/<name>`:

```bash
HOST=$(node -e 'console.log(require("os").hostname())')
npx convex run solverCheckouts:upsert \
  "{\"host\":\"$HOST\",\"repo\":\"owner/name\",\"path\":\"~/solver-checkouts/<name>\"}"
# → "saved" | "invalid" | "full"      (re-running just updates the row)
```

The row starts as `provision: "requested"`; a running solver on that host picks it
up live (no restart), streams progress into `provisionProgress`, and finishes as
`ready` (with a `provisionReport` of what it copied and what remains manual) or
`failed` (`provisionError`). If it registers against an already-prepared clone, the
provisioner detects that and no-ops straight to ready.

`instructions` is an optional extra field on the same upsert — free text the solver
injects into every solve prompt for this repo. Add it when the repo has a setup
quirk a build agent would otherwise trip on ("`npm install` needs
`--legacy-peer-deps`", "copy `X.example` to `X` before running tests"). Check the
finished `provisionReport` — when it names an install workaround, offer to save it
as `instructions` so future solves inherit it.

The user can do all of this from the console instead — **Solver checkouts** on the
nav rail (type the repo, Save — path and provisioning are automatic) — and edit it
there later; mention that rather than making them come back to an agent.

### 4. Solver process

Provisioning and solving both need a solver **running on this host**. Registering
alone just queues the request:

```bash
pgrep -fl "worker/solver.mjs" ||
  nohup node worker/solver.mjs >> worker/solver.out 2>&1 < /dev/null & echo $! > worker/solver.pid
```

### 5. Verify + report

Confirm what actually took:

```bash
curl -fsS "$SITE/health"                         # → {"ok":true}
npx convex run repos:list          # includes owner/name
gh api repos/owner/name/hooks --jq '.[].events'  # includes pull_request + issues (if a hook was set)
npx convex run solverCheckouts:board              # the row: provision lifecycle +
                                                  # "status" validation verdict
```

Wait for `provision` to leave `requested`/`provisioning` (cloning + setup takes a
few minutes; poll the board). `ready` + `status: "ok"` = solvable (`statusDetail`
carries non-fatal warnings; read `provisionReport` for what remains manual —
usually nothing, sometimes a secret file no sibling clone had). `failed` →
`provisionError` has the reason; fix and retry via
`npx convex run solverCheckouts:requestProvision '{"id":"<rowId>"}'`.

Then report concisely:

- ✅ **Reviewed:** watched + webhook (or "via reconcile, no webhook"). New PRs are
  reviewed automatically; `reviewloop-await`/`reviewloop-ack` work against it.
- ✅ **Solvable** (unless review-only): registered for this host, provisioned by the
  solver (relay the provisionReport — especially anything left manual), verdict ok.
- **To trigger a solve:** label any open issue **`ready-for-agent`** (a human gate —
  via the triage flow or `gh issue edit <n> --repo owner/name --add-label ready-for-agent`).
  The solver claims it, spawns `/reviewloop-feature` in the checkout, opens a PR (`Closes #N`),
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
