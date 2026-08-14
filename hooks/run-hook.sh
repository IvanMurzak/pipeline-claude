#!/bin/sh
# hooks/run-hook.sh — resolves an absolute `pipeline` binary and runs it with
# the arguments this plugin's hooks.json passes (always `hook <name>`).
#
# WHY THIS EXISTS: Claude Code runs plugin hook commands through
# non-interactive /bin/sh, which does NOT source ~/.zshrc or ~/.bash_profile.
# On macOS a global install lands in ~/.bun/bin by default and PATH only gains
# that entry from the interactive shell's rc file — so when Claude Code is
# launched from the Dock/Finder (not a terminal), the hook subprocess's
# inherited PATH has no `pipeline` on it and a bare `pipeline hook <name>`
# hook command fails with "/bin/sh: pipeline: command not found". Windows is
# better positioned: its installer writes to a directory on the machine-wide
# PATH, which every process inherits regardless of how it was launched — and
# under the MSYS `sh` Claude Code uses there, BOTH `command -v pipeline` and
# `[ -x "$HOME/.bun/bin/pipeline" ]` resolve the `pipeline.exe` the installer
# actually writes, so no `.exe` special-casing is needed here (verified, not
# assumed — plugin-thin `p6` / T-CLI-2).
#
# WHAT IT RESOLVED BEFORE, AND WHY THAT CHANGED: until plugin-thin `p6` this
# same shim resolved `bun`, because the hooks were `.ts` relay scripts shipped
# inside this plugin and run as `bun <relay>.ts`. The relays are now
# subcommands of the CLI itself (`pipeline hook <name>`, in the separate
# `IvanMurzak/pipeline` repository), so a hook's version is the CLI's version
# by construction. The shim SURVIVES — same probe order, same `--loud`
# contract — it just resolves a different binary. Do not delete it; the
# failure it prevents has nothing to do with which binary is at the end of it.
#
# This script is POSIX sh — macOS /bin/sh is NOT bash: no `[[ ]]`, no
# arrays, no `source`. It resolves the binary's absolute path itself, before
# any JS runs (the failure this fixes happens before a JS runtime exists to
# help), then runs it with stdin/stdout/stderr INHERITED, so the hook payload
# on stdin and the relay's own stdout/stderr/exit code pass through untouched
# — Claude Code feeds hook JSON on stdin and inspects the relay's own stdout
# and exit code, so nothing here may buffer, wrap, reorder or swallow them.
#
# ── VERSION SKEW: an old CLI must not block the session ─────────────────────
#
# The one thing this shim no longer does is `exec`. `exec` made it perfectly
# transparent, and that was right while the arguments were a file path — but
# after `p6` they are a SUBCOMMAND NAME, and a subcommand can be absent. A
# user whose plugin auto-updates while their globally installed CLI does not
# gets `pipeline: unknown command 'hook'` → exit 2, and a non-zero exit from
# PreToolUse BLOCKS THE TOOL CALL. That is not a degraded session, it is a
# broken one, on nearly every turn — the plugin-thin release blocker found by
# `p6`. This shim is the only part of the chain that runs before the CLI is
# reached, so the mitigation has to live here; a SessionStart version check
# warns once while PreToolUse keeps failing.
#
# So for the `hook` shape only, the binary is run WITHOUT `exec` and its exit
# code is inspected. Transparency is preserved exactly — a plain command in
# `sh` inherits the same three file descriptors `exec` would hand over, so
# nothing is piped, buffered or rewritten; the only difference is that this
# shell survives to look at `$?`.
#
# TELLING THE TWO NON-ZERO EXITS APART — the crux. "This CLI has never heard
# of `hook`" and "the hook ran and deliberately failed" both arrive as a
# non-zero status, and they must not be treated alike: a PreToolUse deny is a
# CORRECT non-zero exit (the `pipeline fix` scope guard denies out-of-scope
# Edit/Write/MultiEdit that way), and swallowing it would silently disable a
# safety control. A blanket `exit 0` is therefore not a fix, it is a
# regression. The refusal is not read out of the failed run's stderr either —
# capturing that stream is exactly the buffering this file may not do.
#
# Instead, ONLY AFTER a non-zero exit, the CLI is asked a separate, read-only
# question: `pipeline hook --help`. It is a pure help path with no side
# effects, it never runs a relay, and its answer is unambiguous —
#   • a CLI that HAS the subcommand prints its help and exits 0
#     → the failure came from the relay itself → propagate the original code
#   • a CLI that does NOT prints `pipeline: unknown command 'hook'` and exits
#     non-zero → version skew → warn (loud only) and exit 0
# The probe's own output is captured (never leaked into the hook's stdout,
# which Claude Code parses) and its stdin is /dev/null (it cannot consume the
# hook payload). Anything ambiguous — probe fails for some other reason, no
# recognisable refusal — PROPAGATES the original exit code: the safe default
# is to let a failure through, never to swallow one.
#
# Cost: zero on the normal path (the probe only runs after a failure), one
# extra short-lived process on a path that has already failed.
#
# ── MINIMUM CLI VERSION: hook-capable but still too old (plugin-thin B.2) ───
#
# The mitigation above only classifies "this CLI has never heard of `hook`".
# It says nothing about a CLI that DOES answer `hook --help` — and every
# relay call — but is nonetheless older than what this plugin's skills and
# agents actually assume (a flag `pipeline next` only just grew, for
# example). T-CLI-1 was answered NO (2026-08-14, re-checked here): the plugin
# manifest schema (`.claude-plugin/plugin.json`) has no field for an external
# prerequisite, so MIN_CLI_VERSION below is the single declared floor, and
# this file is the only place that compares against it — `pipeline --version`
# is not checked anywhere else in this plugin.
#
# The check runs ONLY on the `--loud` SessionStart entry (`--loud hook
# session-relay`), and ONLY after that relay call has already succeeded —
# i.e. only once this CLI is already known to have `hook`. That keeps this
# mechanism and the one above strictly disjoint: a CLI old enough to fail the
# `hook --help` probe is classified (and warned about) up there and never
# reaches this check, so the two can never both print in the same session.
# Too old → one line to stderr naming the upgrade command; current or newer →
# silence; a `--version` output that doesn't parse as this CLI's real shape
# (bare `N.N.N`, verified against an actual install — see
# check_min_cli_version below) → treated as UNKNOWN, reported once, never
# treated as "too old" and never silently ignored.
#
# Channel, deliberately: STDERR — the same one the not-installed and
# no-hook-subcommand lines above already use. Per Claude Code's hooks docs
# (verified 2026-08-14), a SessionStart hook's STDOUT becomes
# additionalContext — text Claude's context can see, not a guaranteed
# user-visible banner — and SessionStart cannot block the session either way.
# Matching the existing lines' channel keeps this file's `--loud` contract
# single-shaped instead of adding a second delivery mechanism for what is the
# same class of message.
#
# Usage: run-hook.sh [--loud] <args passed to `pipeline`>
#   --loud   pipeline-not-found, and an unusably old CLI — whether it lacks
#            `hook` entirely or merely falls below MIN_CLI_VERSION — each
#            print ONE actionable line to stderr before exiting 0 (never more
#            than one such line per session; the two old-CLI mechanisms are
#            mutually exclusive, see MINIMUM CLI VERSION above). Reserved for
#            SessionStart, which fires once per session and is where a user
#            can actually see and act on it. After `p6` the plugin genuinely
#            REQUIRES an installed CLI of a recent enough version — it ships
#            no code of its own any more — so that line is the whole safety
#            net, and it names the install/upgrade command rather than merely
#            reporting the problem.
#   (default / no flag) both conditions exit 0 with NO output of our own —
#            used for every other hook type. PreToolUse/PostToolUse/
#            UserPromptSubmit fire on nearly every turn; printing there would
#            flood the session, which is worse than the silent no-op these
#            non-blocking hooks already degrade to when disabled.
#
# Resolution order (first hit wins — never regresses a machine where the CLI
# already works today):
#   1. pipeline already on PATH          (command -v pipeline)
#   2. "$BUN_INSTALL/bin/pipeline"       (bun's own env var, if set)
#   3. "$HOME/.bun/bin/pipeline"         (default bun global-install location)
#   4. /opt/homebrew/bin/pipeline        (Homebrew, Apple Silicon)
#   5. /usr/local/bin/pipeline           (Homebrew Intel / common Linux, and
#                                         npm's default global prefix there)

# Minimum @baizor/pipeline version this plugin's skills/agents/hooks assume.
# SINGLE SOURCE OF TRUTH for that number — nothing else in this repository
# may declare it a second time (one source; two is the failure mode this
# exists to prevent). Bump it when a skill, agent or hook starts depending on
# a CLI feature this version predates (see CHANGELOG.md's "requires a CLI new
# enough for …" notes). Floor chosen 2026-08-14 as the version verified
# locally to support both `pipeline hook <name>` and `pipeline next
# --brief-file`, the two newest hard CLI dependencies this plugin has.
MIN_CLI_VERSION="0.19.0"

# Compares $PIPELINE_BIN's own `--version` output against MIN_CLI_VERSION and
# prints exactly one line to stderr if it is older; silent if current, newer,
# or unparseable-but-still-warned-once (see below). Never touches the
# caller's exit code or `$status` — version skew here must never block the
# session, exactly like the mechanism above. Callers must gate on `--loud`
# themselves; this function does not check `$mode`.
#
# `--version`'s actual output shape was checked against a real install, not
# assumed: a bare `N.N.N`, nothing else, exit 0. Anything that does not fit
# that exact shape (extra text, a `v` prefix, fewer/more than three numeric
# parts, an empty part) is UNKNOWN — reported once, never treated as "too
# old" and never silently swallowed, so a CLI that changes its `--version`
# shape later degrades to a note instead of a false accusation. A trailing CR
# is stripped with pure parameter expansion (no external `tr`, deliberately —
# this shim resolves its own PATH and must not assume anything else is on it)
# in case a CRLF-emitting binary is ever in the resolution chain (this repo
# has shipped that exact class of bug before), even though the real CLI
# verified here does not emit one.
check_min_cli_version() {
  cmcv_installed=$("$PIPELINE_BIN" --version 2>&1 </dev/null)
  cmcv_cr=$(printf '\r')
  cmcv_installed=${cmcv_installed%"$cmcv_cr"}

  cmcv_shape_ok="yes"
  case "$cmcv_installed" in
    ''|*[!0-9.]*) cmcv_shape_ok="" ;;
  esac

  if [ -n "$cmcv_shape_ok" ]; then
    IFS='.'
    set -- $cmcv_installed
    unset IFS
    if [ $# -ne 3 ]; then
      cmcv_shape_ok=""
    else
      cmcv_i_major=$1
      cmcv_i_minor=$2
      cmcv_i_patch=$3
      case "$cmcv_i_major" in ''|*[!0-9]*) cmcv_shape_ok="" ;; esac
      case "$cmcv_i_minor" in ''|*[!0-9]*) cmcv_shape_ok="" ;; esac
      case "$cmcv_i_patch" in ''|*[!0-9]*) cmcv_shape_ok="" ;; esac
    fi
  fi

  if [ -z "$cmcv_shape_ok" ]; then
    printf '%s\n' "pipeline plugin: could not read the installed 'pipeline' CLI's version (--version printed '$cmcv_installed') - skipping the minimum-version check for this session; if something behaves oddly, upgrade with 'bun add -g @baizor/pipeline' (or 'npm i -g @baizor/pipeline')" >&2
    return
  fi

  IFS='.'
  set -- $MIN_CLI_VERSION
  unset IFS
  cmcv_m_major=$1
  cmcv_m_minor=$2
  cmcv_m_patch=$3

  cmcv_older=""
  if [ "$cmcv_i_major" -lt "$cmcv_m_major" ]; then
    cmcv_older="yes"
  elif [ "$cmcv_i_major" -eq "$cmcv_m_major" ]; then
    if [ "$cmcv_i_minor" -lt "$cmcv_m_minor" ]; then
      cmcv_older="yes"
    elif [ "$cmcv_i_minor" -eq "$cmcv_m_minor" ] && [ "$cmcv_i_patch" -lt "$cmcv_m_patch" ]; then
      cmcv_older="yes"
    fi
  fi

  if [ -n "$cmcv_older" ]; then
    printf '%s\n' "pipeline plugin: the installed 'pipeline' CLI ($cmcv_installed) is older than this plugin needs (>= $MIN_CLI_VERSION) - upgrade with 'bun add -g @baizor/pipeline' (or 'npm i -g @baizor/pipeline')" >&2
  fi
}

mode="quiet"
if [ "${1:-}" = "--loud" ]; then
  mode="loud"
  shift
fi

if [ -z "${1:-}" ]; then
  # Nothing to run — misconfigured hooks.json entry, not our problem to report.
  exit 0
fi

PIPELINE_BIN=""

if command -v pipeline >/dev/null 2>&1; then
  PIPELINE_BIN="$(command -v pipeline)"
elif [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/pipeline" ]; then
  PIPELINE_BIN="$BUN_INSTALL/bin/pipeline"
elif [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/pipeline" ]; then
  PIPELINE_BIN="$HOME/.bun/bin/pipeline"
elif [ -x /opt/homebrew/bin/pipeline ]; then
  PIPELINE_BIN="/opt/homebrew/bin/pipeline"
elif [ -x /usr/local/bin/pipeline ]; then
  PIPELINE_BIN="/usr/local/bin/pipeline"
fi

if [ -z "$PIPELINE_BIN" ]; then
  if [ "$mode" = "loud" ]; then
    printf '%s\n' "pipeline plugin: the 'pipeline' CLI is not installed (checked PATH, \$BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin) - install it with 'bun add -g @baizor/pipeline' (or 'npm i -g @baizor/pipeline'), or set BUN_INSTALL to its install directory; this plugin needs it for every skill, agent and hook" >&2
  fi
  exit 0
fi

# Anything that is not the `hook` shape keeps the original `exec`: only the
# hook relays are on the "must never block the session" contract, and only
# `hook` is the subcommand an out-of-date CLI can be missing. A skill or agent
# that shells through this shim WANTS a failure to surface verbatim.
if [ "$1" != "hook" ]; then
  exec "$PIPELINE_BIN" "$@"
fi

# stdin/stdout/stderr are inherited exactly as `exec` would have handed them
# over — no pipe, no capture, no reordering. Nothing may come between this
# line and the `$?` that reads its status.
"$PIPELINE_BIN" "$@"
status=$?

if [ "$status" -eq 0 ]; then
  # This CLI just answered `hook` successfully, so it is not the "no `hook`
  # subcommand at all" case the probe below classifies. It can still be older
  # than MIN_CLI_VERSION — the check is scoped to --loud (SessionStart) only,
  # both to avoid flooding every other hook and because it is the only entry
  # a user can act on.
  if [ "$mode" = "loud" ]; then
    check_min_cli_version
  fi
  exit 0
fi

# Non-zero. Is this a relay that genuinely failed (propagate — it may be a
# deliberate PreToolUse deny), or a CLI too old to know `hook` at all (exit 0
# — never block a session over a version skew)? Ask the CLI directly, on a
# read-only help path, with its output captured and its stdin closed.
probe_output=$("$PIPELINE_BIN" hook --help 2>&1 </dev/null)
probe_status=$?

if [ "$probe_status" -eq 0 ]; then
  # The CLI knows `hook`. The non-zero came from the relay itself and is
  # meaningful — a PreToolUse deny among other things. Propagate it verbatim.
  exit "$status"
fi

case "$probe_output" in
  *"unknown command"* | *"Unknown command"*)
    # Top-level refusal: this CLI has no `hook` subcommand at all. Note the
    # shape being matched is the refusal of the COMMAND `hook`, which a CLI
    # that implements it can never emit — its own unknown-NAME error reads
    # `pipeline hook: unknown hook '<name>'` and only ever follows a `hook`
    # it recognised.
    ;;
  *)
    # Probe failed for a reason we do not recognise (binary broken, killed,
    # some future error path). Do not guess: propagate, the same as today.
    exit "$status"
    ;;
esac

if [ "$mode" = "loud" ]; then
  printf '%s\n' "pipeline plugin: the installed 'pipeline' CLI is too old for this plugin - it has no 'hook' command, so every Pipeline hook is inert (they are CLI subcommands since plugin v0.93.0); upgrade with 'bun add -g @baizor/pipeline' (or 'npm i -g @baizor/pipeline') and restart the session" >&2
fi

# Exit 0 REGARDLESS of mode: the loud/quiet contract governs the message, not
# the status. A non-zero here would block the tool call this hook observed.
exit 0
