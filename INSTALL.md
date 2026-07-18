# Install reviewloop — agent playbook

You are an AI coding agent (Claude Code, Codex, or similar) installing
**reviewloop** for the user on this machine. Follow this file top to bottom.

reviewloop is an event-driven PR-review console: a GitHub webhook pushes
`pull_request` events into a Convex deployment **the user owns**; a local
worker subscribes over the Convex websocket and reviews each PR the moment it
opens or is pushed to, by spawning `claude -p` in a throwaway clone; a local
web page shows the live board. Nothing is hosted by anyone else — their
machine, their Convex project, their GitHub webhooks.

```
GitHub PR event ──HTTPS──▶ their Convex deployment  (/github/webhook)
                                  │ reviews table (queued → reviewing → reviewed)
                ┌─────────────────┴───────────────┐
                ▼                                 ▼
        local worker (Node)              local dashboard (Vite)
        spawns `claude -p` per PR        http://localhost:5180
```

Every step is **idempotent**: check state first, only create what's missing.
Re-running this playbook on a half-finished install just completes it.

## Ground rules

- **Interactive logins belong to the user.** `npx convex login`,
  `gh auth login`, and anything that opens a browser must be run by the user,
  not you. In Claude Code, tell them to type `! <command>` so it runs
  in-session and you see the output; in other agents, ask them to run it in a
  terminal and tell you when it's done.
- **Never invent secret values.** Generate secrets with the exact commands
  given below; never type a made-up string into an env var.
- **Check before you create.** Webhooks, env vars, config lines: look at what
  exists first, and only add what's missing.
- **Narrate as you go.** Before each outward action (creating a webhook,
  writing to a file outside the repo), say what you're about to do in one
  line. Finish with the report in step 7.

## 0. Preflight

Check each requirement; help the user fix anything missing before continuing:

| requirement | check | if missing |
| --- | --- | --- |
| Node.js ≥ 20 | `node --version` | install via their usual channel (nvm, brew, …) |
| git | `git --version` | platform installer |
| GitHub CLI, authenticated | `gh auth status` | install `gh`, then `gh auth login` (user-run, interactive) |
| Claude Code CLI | `claude --version` | see below |

**The Claude Code CLI is the review engine.** The worker performs each review
by spawning `claude -p` — this is required even if *you*, the installing
agent, are something else (Codex, etc.). If it's missing, point the user at
<https://claude.com/claude-code> and pause until it's installed and logged
in. (A `codex exec` engine adapter is a welcome contribution, but doesn't
exist yet.)

## 1. Get the code

Ask where to put it if the user hasn't said; default to `~/reviewloop`:

```bash
git clone https://github.com/fagnersales/reviewloop ~/reviewloop
cd ~/reviewloop
npm install
```

If the user has **forked** the repo, clone their fork instead and add the
canonical repo as `upstream` — that's what lets them pull new features later
while keeping their own changes:

```bash
git clone https://github.com/<their-user>/reviewloop ~/reviewloop
cd ~/reviewloop
git remote add upstream https://github.com/fagnersales/reviewloop
npm install
```

All remaining steps run from the repo root.

## 2. The Convex backend (their own free project)

reviewloop's backend — the webhook receiver, the reviews table, the reactive
websocket — deploys to [Convex](https://convex.dev) under the **user's own
account**. The free tier is more than enough for this workload.

**If the user has never used Convex**, walk them through it rather than
assuming knowledge:

1. Explain it in one line: *"Convex is a hosted reactive database + functions
   platform; reviewloop pushes its backend there, and the worker/dashboard on
   your machine subscribe to it live."* An account is free — sign-in is via
   GitHub or Google, no card.
2. Have **the user** run the interactive login (opens a browser):

   ```bash
   npx convex login
   ```

3. If they hit trouble (org policies, no browser), point them at
   <https://docs.convex.dev> and help them through what they see — don't
   guess at credentials.

**Create the deployment and push the functions.** The first run asks a couple
of questions (create a new project? name?) — so run it where the user can
answer; have them pick a **new** project (default name `reviewloop` is fine):

```bash
npx convex dev --once
```

On success this writes `.env.local` (`CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`)
and pushes the backend. If `.env.local` already exists with a
`VITE_CONVEX_URL`, the deployment is already set up — just re-run
`npx convex dev --once` to push and move on.

Derive the **site URL** (where webhooks land): it's `VITE_CONVEX_URL` with
`.convex.cloud` → `.convex.site`. Verify the backend is live:

```bash
CLOUD=$(grep -E '^VITE_CONVEX_URL=' .env.local | cut -d= -f2-)
SITE=${CLOUD/.convex.cloud/.convex.site}
curl -fsS "$SITE/health"    # → {"ok":true}
```

Note the scope: `/health` proves only the **hosted Convex backend** is up. It
says nothing about the local worker — that's a separate process, verified in
step 4. A green `/health` with a dead worker means webhooks queue reviews that
nothing picks up.

## 3. Secrets

Two generated values (check `npx convex env list` first — skip any that are
already set):

```bash
# Shared secret between GitHub webhooks and the Convex receiver:
SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
npx convex env set GITHUB_WEBHOOK_SECRET "$SECRET"

# Passcode that unlocks the console UI:
PASSCODE=$(node -e "console.log(require('crypto').randomBytes(6).toString('hex'))")
npx convex env set ACCESS_PASSCODE "$PASSCODE"
```

Then mirror the passcode into `.env.local` (check it isn't already there —
never append a duplicate):

```bash
grep -q '^VITE_ACCESS_PASSCODE=' .env.local || echo "VITE_ACCESS_PASSCODE=$PASSCODE" >> .env.local
```

`VITE_ACCESS_PASSCODE` in `.env.local` is what makes the **local** console
the full admin console (no login screen, write access). The server-side
`ACCESS_PASSCODE` only matters if they later host a read-only copy of the
page; setting both now keeps them in sync. Tell the user the passcode and
that it's saved in `.env.local`.

## 4. Run it

Start the worker and the dashboard in the background:

```bash
nohup node worker/index.mjs >> worker/worker.out 2>&1 < /dev/null & echo $! > worker/worker.pid
nohup npm run dev >> worker/dashboard.out 2>&1 < /dev/null & echo $! > worker/dashboard.pid
```

Verify:

```bash
tail -5 worker/worker.out            # healthy startup looks like:
#   [14:07:31Z] worker "their-hostname" up; convex=https://….convex.cloud concurrency=2
#   [14:07:32Z] watch list (0): (empty)
curl -fsS http://localhost:5180 >/dev/null && echo dashboard up
```

(Log timestamps are UTC, marked with `Z`. An empty watch list is normal at
this point — step 5 adds the first repo.)

The dashboard is at **http://localhost:5180**. To stop either, use the pid
files — with a liveness guard, because a pid file left by a crash or reboot
can point at an unrelated process that reused the pid:

```bash
# worker
pid=$(cat worker/worker.pid) && ps -p "$pid" -o command= | grep -q worker/index.mjs && kill "$pid"
# dashboard
pid=$(cat worker/dashboard.pid) && ps -p "$pid" -o command= | grep -Eq 'npm|node|vite' && kill "$pid"
```

These survive the terminal but not a reboot — after a reboot the user re-runs
the two commands above (or asks their agent to).

## 5. Watch the first repo

Ask the user which repo they want reviewed (`owner/name`). Then:

**5a. Add it to the watch list** (also doable later from the dashboard's `+`
control):

```bash
npx convex run repos:list                             # current watch list
npx convex run repos:add '{"repo":"<owner/name>"}'    # → "added" | "exists"
```

Adding a repo immediately queues reviews for its open, non-draft PRs.

**5b. Create the GitHub webhook** (makes new pushes instant; check first —
a hook may already point at this deployment):

```bash
gh api repos/<owner/name>/hooks \
  --jq '.[] | select((.config.url // "") | endswith("/github/webhook")) | {id, events}'
```

If none exists, create one with the secret from step 3 (re-read it with
`SECRET=$(npx convex env get GITHUB_WEBHOOK_SECRET)` if the shell lost it):

```bash
gh api repos/<owner/name>/hooks \
  -f name=web -F active=true \
  -f 'events[]=pull_request' \
  -f config[url]="$SITE/github/webhook" \
  -f config[content_type]=json \
  -f config[secret]="$SECRET"
```

If GitHub returns 403, the token lacks the `admin:repo_hook` scope: have the
user run `gh auth refresh -s admin:repo_hook` and retry, or add the webhook
by hand in **repo Settings ▸ Webhooks** (payload URL `$SITE/github/webhook`,
content type `application/json`, that secret, event: Pull requests).

Even without the webhook the repo still works — the worker's fallback
reconcile polls via `gh` every ~30 min; the webhook just makes it instant.

> A watched repo gets auto-cloned and reviewed under
> `claude --permission-mode bypassPermissions`, so the user should only watch
> repos they trust.

For more repos later — or to make a repo *solvable* (the optional
issue→PR autonomous solver) — use the `onboard-repo` skill
(`.claude/skills/onboard-repo/SKILL.md`), which handles both layers
idempotently.

## 6. Wire the user's coding agents (recommended)

Two small integrations make reviewloop useful from *other* repos:

**6a. Put the CLIs on PATH:**

```bash
npm link    # installs reviewloop-await / reviewloop-ack / reviewloop-suggest
```

If `npm link` fails on permissions, don't use sudo — the CLIs also work as
`node <reviewloop-root>/worker/await.mjs` etc.; use absolute paths in 6b.

**6b. Teach their agents to block on reviews.** Show the user the snippet at
`integrations/global-agent-snippet.md`, and with their OK append it to their
global agent instructions — `~/.claude/CLAUDE.md` for Claude Code,
`~/.codex/AGENTS.md` for Codex (create the file if absent). Replace
`<REVIEWLOOP_ROOT>` in the snippet with the actual install path. After this,
any agent that pushes a PR in a watched repo knows to wait for the review
and act on the verdict instead of asking the human.

## 7. Verify end-to-end + report

The real test: have the user push a commit to any open PR in the watched repo
(or open a throwaway PR). Within seconds the dashboard board should go
**Queued → Verifying (timer) → Verified** with a link to the posted review
(a review takes ~10 min).

Then give the user a closing report:

- Dashboard: http://localhost:5180 (passcode saved in `.env.local`)
- Convex deployment: their `VITE_CONVEX_URL`, dashboard via `npx convex dashboard`
- Worker: running (pid in `worker/worker.pid`), log at `worker/worker.out`
- Watched repos: the list from `npx convex run repos:list`
- Start/stop commands (step 4), and that nothing auto-starts on reboot
- **Updating:** to get new features later, they tell their agent:
  *"Open UPDATE.md in my reviewloop folder and follow it"* (in Claude Code,
  `/update-reviewloop` from the repo also works)
- Not installed by default: the autonomous **solver** (issue → PR) — see
  README § "The autonomous solver" when they want it
