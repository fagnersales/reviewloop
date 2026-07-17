#!/usr/bin/env bash
# reviewloop-await → cmux review-ring adapter.
#
# One consumer of the generic REVIEWLOOP_AWAIT_HOOK lifecycle contract that await.mjs
# emits (`start <waiterPid> <repo> <pr> <sha>` / `end <exitCode> …`). It lights
# the cmux pane ring while a review is in flight and colours it by outcome.
#
# Enable it (cmux users only — everyone else just leaves REVIEWLOOP_AWAIT_HOOK unset):
#   export REVIEWLOOP_AWAIT_HOOK="$PWD/integrations/cmux-ring.sh"
# Put that in your shell profile, or have your cmux fork inject it into the pane
# environment alongside the CMUX_* vars below.
#
# Zero plumbing: cmux injects CMUX_WORKSPACE_ID (the set-status target) and
# CMUX_SOCKET_PATH (routes the CLI to the right app instance) into the pane and
# every child inherits them, so `cmux set-status` self-targets from here even
# though await.mjs runs several forks deep in the background. Outside cmux,
# CMUX_WORKSPACE_ID is unset and this is a clean no-op.
#
# Ring colours (cmux reserved key `cmux.review`): reviewing→orange, clean→green,
# blocked→red, failed→amber, timeout→grey, cleared→off. The amber `failed` and
# grey `timeout` states need a cmux build that has those cases (the ring is a
# fork-only feature, and this project's fork adds them). On an older ring build
# that lacks them, a `failed`/`timeout` value falls through to orange ("still
# running") — if you target such a build, map the `3)`/`124)` arms below to
# `blocked` / `clear-status` instead.

[ -n "$CMUX_WORKSPACE_ID" ] || exit 0          # not inside cmux → nothing to do
command -v cmux >/dev/null 2>&1 || exit 0      # cmux CLI absent → nothing to do

case "$1" in
  start)
    # $2 = waiterPid → bind it so cmux's stale-PID sweep clears the ring if the
    # waiter is SIGKILLed and never reaches its `end` edge.
    cmux set-status cmux.review reviewing --pid="$2"
    ;;
  end)
    case "$2" in
      0)   cmux set-status   cmux.review clean   ;;   # green — reviewed, no P0/P1
      2)   cmux set-status   cmux.review blocked ;;   # red   — P0/P1 blockers
      3)   cmux set-status   cmux.review failed  ;;   # amber — review errored (infra), not a code verdict
      124) cmux set-status   cmux.review timeout ;;   # grey  — gave up waiting, outcome unknown
      *)   cmux clear-status cmux.review         ;;   # off   — usage/connection error (exit 1) etc.
    esac
    ;;
esac
