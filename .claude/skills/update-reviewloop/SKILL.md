---
name: update-reviewloop
description:
  Update this reviewloop install to the latest upstream version — preview the
  changelog, pull (or merge upstream on a fork), reinstall deps, push the
  Convex functions, and restart the worker safely. Use when the user says
  "update reviewloop", "upgrade reviewloop", or wants the newest features.
---

# Update reviewloop

Follow `UPDATE.md` at the reviewloop repo root, top to bottom. It is the
single source of truth for the update flow (locate → preview changelog →
pull/merge → `npm install` → `npx convex dev --once` → restart the worker
without killing an in-flight review → verify).
