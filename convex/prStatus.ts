// The PR-status module: one place answers "what state is this PR in?".
//
// A `reviews` row is one review pass; a PR is the set of passes sharing
// (repo, prNumber). Two rules used to be re-derived all over reviews.ts and the
// frontend and now live only here:
//
//   1. Which pass speaks for the PR — `latestPass` (newest `queuedAt`), or
//      `preferredPass` where a terminal reviewed row should win over a newer
//      failed retry of the same head SHA.
//   2. The lifecycle state the PR resolves to — `statusKey`, the 8-state union
//      the console renders. The backend's 4 stored statuses fan out: a
//      `reviewed` pass is "inprogress" (an agent acked it), "awaiting" (it has
//      blockers or unparseable counts and nobody's on it), or "verified".
//
// `statusKey` is computed server-side in `reviews.prs` and shipped on the wire —
// the frontend only maps it to tones. worker/await.mjs mirrors `passVerdict`'s
// blockers rule in plain JS (it can't import TS); keep the two in sync.
import { v, type Infer } from "convex/values"

export const statusKeyValidator = v.union(
  v.literal("verified"),
  v.literal("awaiting"),
  v.literal("inprogress"),
  v.literal("reviewing"),
  v.literal("queued"),
  v.literal("failed"),
  v.literal("merged"),
  v.literal("closed"),
)
export type StatusKey = Infer<typeof statusKeyValidator>

type ReviewStatus = "queued" | "reviewing" | "reviewed" | "failed"

// The pass the board surfaces for a PR: newest by `queuedAt`. Acks and merge
// requests target this pass so a concurrent re-push can't land them on a
// superseded row. Callers must pass a non-empty array.
export function latestPass<T extends { queuedAt: number }>(rows: T[]): T {
  return rows.reduce((a, b) => (b.queuedAt > a.queuedAt ? b : a))
}

// The most relevant pass among rows that share a head SHA, where a failed
// attempt may coexist with its successful retry: the reviewed row if one
// exists, else the newest. (Enqueue dedup guarantees at most one non-failed row
// per SHA, so "the reviewed row" is unambiguous.)
export function preferredPass<T extends { queuedAt: number; status: ReviewStatus }>(
  rows: T[],
): T {
  const reviewed = rows.filter((r) => r.status === "reviewed")
  return latestPass(reviewed.length ? reviewed : rows)
}

// Group review rows into PRs, keyed `${repo}#${prNumber}`.
export function groupByPr<T extends { repo: string; prNumber: number }>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = `${row.repo}#${row.prNumber}`
    const arr = groups.get(key)
    if (arr) arr.push(row)
    else groups.set(key, [row])
  }
  return groups
}

// The verdict a reviewed pass's finding counts resolve to. p0/p1 are
// best-effort scraped from the agent's report (worker parseReport), so
// undefined ≠ 0: an unparseable count reads as "unknown", never as clean —
// worker/await.mjs applies the same rule to pick its exit code.
export function passVerdict(x: { p0?: number; p1?: number }): "clean" | "blockers" | "unknown" {
  if (x.p0 == null || x.p1 == null) return "unknown"
  return x.p0 > 0 || x.p1 > 0 ? "blockers" : "clean"
}

// The lifecycle state a PR resolves to, from its GitHub state and its latest
// pass. GitHub's merged/closed always wins; a reviewed pass fans out into the
// three states the console exists to surface: an agent acked it (someone's on
// it), it has blockers / unknown counts and nobody's acked (awaiting an
// agent), or it's clean (verified, ready for the human merge gate).
export function statusKey(x: {
  prState?: "merged" | "closed"
  status: ReviewStatus
  ackedAt?: number
  p0?: number
  p1?: number
}): StatusKey {
  if (x.prState === "merged") return "merged"
  if (x.prState === "closed") return "closed"
  switch (x.status) {
    case "reviewing":
      return "reviewing"
    case "queued":
      return "queued"
    case "failed":
      return "failed"
    case "reviewed":
      if (x.ackedAt != null) return "inprogress"
      return passVerdict(x) === "clean" ? "verified" : "awaiting"
  }
}
