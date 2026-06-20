// Cloud-log: an animated, departure-board view of the cloud review session's
// log. Shows the last few lines heavily animated (rows roll up one notch per
// line), with an expand-to-fullscreen overlay for the whole log.
//
// Wire `CloudLogConsole` into the review detail; feed it lines via
// `useProgressHistory(progress)` to bridge the backend's single `progress`
// string into a history without a schema change.
export * from "./types"
export { RollingTicker } from "./rolling-ticker"
export { CloudLogConsole } from "./console"
export { useProgressHistory } from "./use-progress-history"
