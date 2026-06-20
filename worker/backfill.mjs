#!/usr/bin/env node
// One-off backfill: fill prCreatedAt/closedAt on review rows that predate
// timestamp capture, using each PR's real GitHub timestamps.
//
//   node worker/backfill.mjs            # apply
//   node worker/backfill.mjs --dry-run  # show what would change, write nothing
//
// Drives off reviews.prsNeedingTimestamps (PRs still on the fallback), fetches
// created/merged/closed times via `gh`, and patches only-empty fields through
// reviews.backfillPrTimestamps (idempotent). Mirrors await.mjs's Convex wiring.

import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY = process.argv.includes("--dry-run")

function loadConfig() {
  const base = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"))
  try {
    Object.assign(base, JSON.parse(readFileSync(join(__dirname, "config.local.json"), "utf8")))
  } catch {
    /* no local override */
  }
  return base
}

function envLocalUrl() {
  try {
    const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8")
    const get = (k) => txt.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim()
    return get("VITE_CONVEX_URL") || get("CONVEX_URL")
  } catch {
    return undefined
  }
}

const CONVEX_URL = process.env.PRR_CONVEX_URL || loadConfig().convexUrl || envLocalUrl()
if (!CONVEX_URL) {
  console.error("no Convex URL. Set PRR_CONVEX_URL or run `npx convex dev` first.")
  process.exit(1)
}

const ms = (iso) => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

// GitHub's truth for one PR, or null if `gh` can't see it (repo gone, etc.).
function ghTimes(repo, prNumber) {
  const r = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--repo", repo, "--json", "createdAt,mergedAt,closedAt,state"],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return null
  try {
    const j = JSON.parse(r.stdout)
    return {
      prCreatedAt: ms(j.createdAt),
      closedAt: ms(j.mergedAt) ?? ms(j.closedAt), // merge moment preferred
      state: j.state,
    }
  } catch {
    return null
  }
}

const client = new ConvexClient(CONVEX_URL)

try {
  const prs = await client.query(api.reviews.prsNeedingTimestamps, {})
  console.log(`${prs.length} PR(s) on the fallback · ${CONVEX_URL}${DRY ? " · DRY RUN" : ""}`)

  let patchedRows = 0
  let touchedPrs = 0
  let skipped = 0
  for (const { repo, prNumber } of prs) {
    const t = ghTimes(repo, prNumber)
    if (!t || t.prCreatedAt == null) {
      console.warn(`  skip ${repo}#${prNumber} — gh could not resolve it`)
      skipped++
      continue
    }
    const stamps = `created=${t.prCreatedAt}${t.closedAt != null ? ` closed=${t.closedAt}` : ""} (${t.state})`
    if (DRY) {
      console.log(`  would patch ${repo}#${prNumber} · ${stamps}`)
      touchedPrs++
      continue
    }
    const { patched } = await client.mutation(api.reviews.backfillPrTimestamps, {
      repo,
      prNumber,
      prCreatedAt: t.prCreatedAt,
      closedAt: t.closedAt,
    })
    console.log(`  ${repo}#${prNumber} · ${patched} row(s) · ${stamps}`)
    patchedRows += patched
    if (patched > 0) touchedPrs++
  }

  console.log(
    DRY
      ? `dry run: ${touchedPrs} PR(s) resolvable, ${skipped} skipped`
      : `done: patched ${patchedRows} row(s) across ${touchedPrs} PR(s), ${skipped} skipped`,
  )
} finally {
  await client.close()
}
process.exit(0)
