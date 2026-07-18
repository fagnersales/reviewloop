<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# reviewloop — agent pointers

- **Installing this tool for a user?** Follow [INSTALL.md](INSTALL.md).
- **Updating an existing install?** Follow [UPDATE.md](UPDATE.md).
- **Working in this repo** (the code itself)? Read [CLAUDE.md](CLAUDE.md) —
  it is the full agent playbook (waiting on reviews via `worker/await.mjs`,
  acking via `worker/ack.mjs`, the autonomous solver) and applies to every
  agent, not just Claude Code. [CONTEXT.md](CONTEXT.md) holds the domain
  glossary.
