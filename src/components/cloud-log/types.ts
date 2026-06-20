/** Semantic kind of a log line — drives the leading dot colour and glyph. */
export type CloudLogKind = "info" | "done" | "warn" | "error"

/** One line emitted by the cloud review session. */
export type CloudLogLine = {
  /** Stable identity — required so each line animates in exactly once. */
  id: string
  /** The log text for this line. */
  text: string
  /** When the line was emitted (ms since epoch); optional. */
  at?: number
  /** Semantic kind. Defaults to "info". The *newest* line is rendered as the
   *  live/active line independently of this (see `streaming`). */
  kind?: CloudLogKind
}

export type CloudLogProps = {
  /** The full ordered stream, oldest first. */
  lines: CloudLogLine[]
  /**
   * Compact window size — only the last `maxVisible` lines render in the
   * heavily-animated stacked view. Pass `Infinity` (the default) for the full,
   * flat, scrollable view used in fullscreen.
   */
  maxVisible?: number
  /** Whether the newest line is still streaming (drives the active styling). */
  streaming?: boolean
}
