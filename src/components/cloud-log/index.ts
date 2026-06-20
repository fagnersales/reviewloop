// Cloud-log: an animated, departure-board view of the cloud review session's
// log. Shows the last few lines heavily animated (rows roll up one notch per
// line), with an expand-to-fullscreen overlay for the whole log.
//
// Wire `CloudLogConsole` into the review detail and feed it the lines from the
// `reviews.reviewLog` query — the complete, server-persisted history of the
// review pass.
export * from "./types"
export { RollingTicker } from "./rolling-ticker"
export { CloudLogConsole, ExpandLogButton } from "./console"
