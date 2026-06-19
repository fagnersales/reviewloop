import { defineApp } from "convex/server"
import { v } from "convex/values"

// Typed app env vars. After `npx convex dev`, import the generated `env` object
// from `./_generated/server` and read these instead of `process.env` — Convex
// validates them at deploy time and types each access.
const app = defineApp({
  env: {
    // Shared secret GitHub signs each webhook with (X-Hub-Signature-256).
    // Optional so the deployment can exist before the secret is set; the
    // /github/webhook route 503s until it is (see http.ts).
    GITHUB_WEBHOOK_SECRET: v.optional(v.string()),
  },
})

export default app
