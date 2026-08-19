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
# WHEN THE CHECK RUNS — changed by `w4`, and this is the whole of T-CLI-3.
# It used to run ONLY on the `--loud` SessionStart entry, which made a RESTART
# the only thing that could ever re-fire it. But `/reload-plugins` activates a
# plugin upgrade MID-SESSION with no restart, and SessionStart does not fire
# again — so a reloaded plugin carrying a RAISED floor went unchecked for the
# rest of the session. That window was T-CLI-3, and closing it is what the
# marker file below is for.
#
# So the check now runs on EVERY hook invocation — but it must NOT spawn
# `pipeline --version` every time, which would add a process spawn to every
# PostToolUse, i.e. to every tool call. A marker file in the system temporary
# directory caches the verdict for the rest of the session; cli_marker_path
# below documents what its name is keyed on and why each component is there.
# On a cache hit the whole cost is one `[ -e ]` test: no spawn, no fork.
#
# It still runs ONLY after the relay call has already SUCCEEDED — i.e. only
# once this CLI is already known to have `hook`. That keeps this mechanism and
# the one above strictly disjoint: a CLI old enough to fail the `hook --help`
# probe is classified (and warned about) up there and never reaches this
# check, so the two can never both print in the same session.
# Too old → one line to stderr naming the upgrade command; current or newer →
# silence; a `--version` output that doesn't parse as this CLI's real shape
# (bare `N.N.N`, verified against an actual install — see
# check_min_cli_version below) → treated as UNKNOWN, reported once, never
# treated as "too old" and never silently ignored.
#
# ── THE DELIVERY DEFECT: every warning here used to reach NOBODY (`w4`) ─────
#
# All three of this file's warnings — CLI not installed, CLI too old to have
# `hook`, CLI below MIN_CLI_VERSION — printed to stderr and then `exit 0`.
# Claude Code sends a ZERO-exit hook's stderr to the DEBUG LOG ONLY: not the
# transcript, not the user, not Claude. So for their entire existence none of
# the three had ever been seen by anybody. `p8` shipped the third one and `w3`
# recorded it as working. It was not working; it was inaudible.
#
# The fix is the EXIT CODE, not the wording. Measured against Claude Code
# 2.1.236 on 2026-08-19 by running real sessions with a probe hook and reading
# the session transcript back afterwards — not inferred from the docs:
#
#   exit 0 + stderr                    → nothing in the transcript at all
#   exit 1 + stderr, stdout EMPTY      → transcript attachment
#                                        `hook_non_blocking_error`, carrying
#                                        "Failed with non-blocking status
#                                        code: <our line>"          → VISIBLE
#   exit 1 + stderr, stdout PLAIN TEXT → same `hook_non_blocking_error`
#   exit 1 + stderr, stdout SCHEMA-VALID
#                     hook JSON        → attachment `hook_success`: the JSON
#                                        still takes effect, the exit code is
#                                        IGNORED, and our stderr is NOT
#                                        surfaced as an error     → INVISIBLE
#
# and in none of those rows is the action blocked. A PreToolUse hook exiting 1
# was measured letting its Bash tool call run to completion. That is the
# property which makes 1 usable here and 2 unusable: 2 is the BLOCKING status,
# and a version problem must never block a tool call.
#
# WHY NOT A JSON `systemMessage` ON STDOUT: this shim's stdout IS THE RELAY'S
# stdout, inherited, not ours. Writing our own JSON document after — or before
# — the relay has written its own puts two documents on one stream, which at
# best fails to parse and at worst corrupts a relay's contract, a PreToolUse
# permissionDecision among them. stderr has no such contention. The one branch
# where `systemMessage` WOULD be safe is not-installed, where no relay ever
# runs; using it only there would mean two delivery mechanisms for one class
# of message, so stderr + exit 1 is used uniformly instead.
#
# THE RESIDUAL GAP, stated rather than hidden: row 4. If the relay on the
# invocation that happens to claim the once-per-session marker writes
# schema-valid hook JSON to stdout, OUR LINE REACHES NOBODY: the hook is
# classified a success, no notice is raised, and the text survives only as a
# field inside that hook's own transcript record, which nothing renders. It is
# dropped, not deferred. It fails toward SILENCE — never toward a block, never
# toward a swallowed deny — because in that row the relay's own JSON still
# decides the outcome exactly as it does today.
#
# WHAT THE SAFETY ACTUALLY RESTS ON — read this before adding a relay.
# It is NOT that the relays write nothing to stdout. Two of the five DO:
# `department-notifier-relay` (pending department notifications) and
# `prompt-match-relay` (a pipeline suggestion). What makes exit 1 safe is that
# both write SCHEMA-VALID `hookSpecificOutput` JSON, i.e. row 4 — the relay's
# own output survives untouched and only OUR line goes quiet.
#
# A relay writing PLAIN TEXT to stdout would be row 3, and row 3 is not merely
# "our line is visible" — the two rows trade off, they do not stack. Measured,
# same payload, same exit 1, only the stdout FORM differing:
#   • as JSON       → `hook_additional_context` attachment present, and our
#                     line raised NO notice (row 4: the relay's context lands,
#                     our warning is dropped);
#   • as plain text → our line surfaced as `hook_non_blocking_error`, and NO
#                     `hook_additional_context` attachment AT ALL (row 3: our
#                     warning lands, the relay's context is destroyed).
# So on an invocation that also warns, a plain-text relay would LOSE its
# additionalContext — and on SessionStart and UserPromptSubmit plain stdout IS
# the context channel. This is a real constraint on any relay added later, not
# a stylistic one: A RELAY MAY RETURN CONTEXT AS JSON, NEVER AS BARE TEXT.
# Losing our own warning is the acceptable half of that trade; losing a
# relay's payload is not, which is why the JSON form is the one that must hold.
#
# The narrowness is therefore in WHICH invocation speaks, not in the relays
# being silent. The `--loud` SessionStart entry is `session-relay`, which
# writes no stdout at all — but the two SessionStart entries race for the
# marker (see the claim below), so the notifier can win it and, when it does
# have a notification pending, absorb the warning into row 4. The entry that
# would have delivered the line is throttled by then. The next session
# re-fires, so the cost is one deferred warning and never a lost relay
# payload.
#
# Usage: run-hook.sh [--loud] <args passed to `pipeline`>
#   --loud   pipeline-not-found, and a CLI with no `hook` subcommand at all,
#            each print ONE actionable line to stderr and then EXIT 1, so that
#            the line is actually delivered (see THE DELIVERY DEFECT above).
#            Reserved for SessionStart, which fires once per session and is
#            where a user can actually see and act on it. After `p6` the
#            plugin genuinely REQUIRES an installed CLI of a recent enough
#            version — it ships no code of its own any more — so that line is
#            the whole safety net, and it names the install/upgrade command
#            rather than merely reporting the problem.
#   (default / no flag) those two conditions exit 0 with NO output of our own
#            — used for every other hook type. PreToolUse/PostToolUse/
#            UserPromptSubmit fire on nearly every turn; printing there would
#            flood the session, which is worse than the silent no-op these
#            non-blocking hooks already degrade to when disabled.
#
#   NOT GATED ON --loud, since `w4`: the MIN_CLI_VERSION check. It runs on
#   every invocation (T-CLI-3) and is flood-proofed by the once-per-session
#   marker instead of by the mode flag — a marker survives a `/reload-plugins`
#   that no SessionStart follows, and a mode flag cannot. When it warns, it
#   exits 1 too. The two old-CLI mechanisms remain mutually exclusive, so at
#   most ONE such line is ever printed per session.
#
#   EXIT 1 IS NEVER A BLOCK, and this file never produces an exit 2 of its
#   own. The only 2 it can emit is a relay's own, propagated verbatim (see
#   TELLING THE TWO NON-ZERO EXITS APART above).
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

# Sets $cli_marker to the absolute path of the once-per-session marker file
# that gates the MIN_CLI_VERSION check, or returns non-zero when there is no
# usable temporary directory — in which case the caller stays SILENT. A
# marker that cannot be placed must degrade to no message at all, never to a
# message on every hook.
#
# WHAT THE NAME IS KEYED ON, and why each component has to be there:
#
#   • MIN_CLI_VERSION — THE COMPONENT THAT CLOSES T-CLI-3. A `/reload-plugins`
#     that activates a plugin carrying a RAISED floor yields a different key,
#     so the check re-fires mid-session with no restart.
#
#   • the plugin root: `${CLAUDE_PLUGIN_ROOT}` if the host exports it, else
#     `$0`. MEASURED (Claude Code 2.1.236, 2026-08-19): for a hook `command`,
#     `${CLAUDE_PLUGIN_ROOT}` is a PATH PLACEHOLDER SUBSTITUTED INTO THE
#     COMMAND STRING and is not necessarily an exported environment variable —
#     a probe hook that dumped its whole environment saw it UNSET. `$0` is the
#     shim's own path, which hooks.json writes as
#     "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh", so it CARRIES the expanded
#     plugin root by construction. Keying on the environment variable alone
#     would have quietly keyed on an empty string. The plugin cache is
#     version-pinned, so this component changes on any plugin version change
#     — belt and braces with the floor above.
#
#   • the resolved PIPELINE_BIN path — a different CLI is a different verdict.
#
#   • a session-stable component, so the message is delivered AT MOST ONCE per
#     session. The hook payload's `session_id` is unreachable from here:
#     reading stdin would consume the relay's payload and break every relay
#     (see the passthrough contract above), so this comes from the environment
#     instead. MEASURED, not assumed, by dumping the environment of real
#     SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop hooks
#     within one session:
#       - CLAUDE_CODE_SESSION_ID  IS set, and is IDENTICAL across all five
#         events of that session. This is the one used.
#       - CLAUDE_SESSION_ID is NOT set — it does not exist. Do not "correct"
#         the name below to it.
#       - $PPID was 1 for every hook process: the hook is reparented, so the
#         parent pid is not session-stable. Worse, it is the SAME 1 in every
#         session, so keying on it would suppress the warning permanently
#         instead of once per session. It reads like a reasonable key and is
#         not one.
#     CLAUDE_CODE_SESSION_ID is UNDOCUMENTED, hence the fallback chain:
#     CLAUDE_PID (also measured present, also session-stable), then the
#     literal `no-session`. That last degrades to "once per plugin version per
#     machine" rather than once per session — and because the plugin root
#     above is version-pinned, a raised floor still re-fires. Degraded, never
#     silent forever, and never a flood.
#
#     The fallback guards DISAPPEARANCE. The failure it does NOT guard, and
#     the one that would actually cost something, is INSTABILITY: if this
#     value ever became per-TURN rather than per-session, every invocation
#     would compute a fresh key, and the throttle would silently become no
#     throttle — a `--version` spawn on every tool call plus a notice on every
#     tool call for anyone below the floor, which is exactly what the marker
#     exists to prevent. Nothing here can detect that. If this variable's
#     semantics are ever revisited, per-session stability is the property to
#     re-verify; presence is not enough.
# The marker must never land inside the plugin root (read-only at runtime) or
# inside the consumer's project, so it goes to the system temporary directory:
# TMPDIR, then TEMP, then TMP, then `/tmp`. All three names are checked
# because none of them is universal — MEASURED on Windows Git Bash: `sh` sets
# TEMP and TMP itself even when the parent process set neither, and sets no
# TMPDIR at all, which is the reverse of a POSIX host. The same measurement
# showed MSYS rewriting a `C:/x` value to `/c/x` on the way in, so the value
# read here is not necessarily in the parent's path style and nothing may
# assume it is. Each rung is tested for existence AND writability, since an
# exported-but-stale TMPDIR is common.
cli_marker_path() {
  cli_marker=""

  cmp_tmp=""
  for cmp_dir in "${TMPDIR:-}" "${TEMP:-}" "${TMP:-}" /tmp; do
    if [ -n "$cmp_dir" ] && [ -d "$cmp_dir" ] && [ -w "$cmp_dir" ]; then
      cmp_tmp=$cmp_dir
      break
    fi
  done
  [ -n "$cmp_tmp" ] || return 1

  cmp_session=${CLAUDE_CODE_SESSION_ID:-}
  [ -n "$cmp_session" ] || cmp_session=${CLAUDE_PID:-}
  [ -n "$cmp_session" ] || cmp_session=no-session

  cmp_key="$MIN_CLI_VERSION|${CLAUDE_PLUGIN_ROOT:-$0}|$PIPELINE_BIN|$cmp_session"

  # Fold the key into ONE filename-safe token in a single pass, using shell
  # builtins only: no `tr`, no `sed`, no `md5sum`/`cksum`/`stat` — this shim
  # resolves its own PATH and may not assume any external tool is reachable.
  # Field-splitting on an IFS of the unsafe characters and rejoining with `_`
  # via "$*" performs the whole substitution at once. `set -f` is essential,
  # not tidiness: the unquoted expansion that does the splitting would
  # otherwise ALSO do pathname expansion, and a `*` in a path would glob
  # against the current directory. Every `/` and `\` becomes `_`, so the token
  # can contain no path separator and no traversal. A tab or newline inside a
  # path would survive into the name; on a filesystem that rejects it the
  # claim below simply fails and we stay silent, which is the safe direction.
  cmp_oldifs=$IFS
  set -f
  IFS='|/\:*?"<> '
  set -- $cmp_key
  IFS='_'
  cmp_token="$*"
  IFS=$cmp_oldifs
  set +f

  # LENGTH, since the name is two absolute paths plus a UUID: it measures
  # ~180-200 characters in a real install against a typical NAME_MAX of 255,
  # so there is headroom but not a lot of it. An unusually deep plugin cache
  # or install prefix can exceed it, and the overflow degrades the same way
  # every other marker failure does — the claim fails, the check is skipped,
  # exit 0, relay untouched. Worth knowing that for THAT user the degradation
  # is permanent and invisible: they would never see a floor warning at all.
  # Shortening the key is not free, though — every component is load-bearing
  # (floor = T-CLI-3, root = version pinning, bin = which CLI, session =
  # throttle) and hashing one would need an external tool this file may not
  # assume. Left as documented headroom rather than solved.
  cli_marker="$cmp_tmp/pipeline-plugin-cli-check-$cmp_token"
}

# Compares $PIPELINE_BIN's own `--version` output against MIN_CLI_VERSION and
# prints exactly one line to stderr if it is older; silent if current, newer,
# or unparseable-but-still-warned-once (see below). Never touches the
# caller's exit code or `$status` — version skew here must never block the
# session, exactly like the mechanism above. It sets `cmcv_warned` when it
# printed something, and the CALLER decides what that means for the exit
# status; this function neither exits nor checks `$mode`.
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
  cmcv_warned=""
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
    cmcv_warned="yes"
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
    cmcv_warned="yes"
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
    # Exit 1, NOT 0 (`w4`). On exit 0 this line reached the debug log and
    # nobody else — see THE DELIVERY DEFECT above. Exit 1 is a non-blocking
    # error on every event, and no relay ran on this path, so our stdout is
    # empty and the line is delivered as a transcript notice.
    exit 1
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
  # than MIN_CLI_VERSION.
  #
  # Runs on EVERY invocation now, not only `--loud` (T-CLI-3 — see WHEN THE
  # CHECK RUNS above), but at most ONCE per session per key, because the
  # marker file is both the cache and the claim:
  #   • `[ -e ]` short-circuits the common case with no fork and no spawn, so
  #     a cache hit costs one test and nothing else;
  #   • the `set -C` (noclobber) creation that follows is an ATOMIC O_EXCL
  #     claim, so the two SessionStart entries — which Claude Code starts
  #     CONCURRENTLY, observed in a real session — cannot both conclude that
  #     they are the one that gets to speak.
  #
  # KNOWN LIMITATION, deliberately accepted: if the user UPGRADES the CLI
  # mid-session the marker still holds the old verdict, because the key
  # carries no CLI version — reading one is precisely the spawn this cache
  # exists to avoid. We therefore stay silent for the rest of that session
  # rather than warning again. Silence after a fix is fine; a false warning is
  # not.
  #
  # Any failure to place the marker — no writable temp dir, a read-only one, a
  # name the filesystem rejects — degrades to SILENCE. Never to a warning on
  # every hook, and never to a non-zero exit.
  #
  # THE MARKER IS CLAIMED BEFORE THE SPAWN, AND THAT ORDERING IS LOAD-BEARING.
  # `check_min_cli_version` runs `$PIPELINE_BIN --version` in a command
  # substitution, which blocks until the CLI exits, and there is NO PORTABLE
  # WAY TO BOUND THAT from POSIX sh: `timeout` is an external tool (absent on
  # a stock macOS), `sleep`-plus-`kill` polling needs `sleep`, also external,
  # and `read -t` is a bashism this file cannot use because it runs under dash
  # on Linux. Depending on any of them would break the one assumption this
  # whole shim exists to avoid — that PATH is usable.
  #
  # The host DOES cap a hook — but the cap is a deadline, not a rescue, and it
  # is PER EVENT. MEASURED (Claude Code 2.1.236):
  #   • UserPromptSubmit: a hook sleeping 70s was cancelled at 30s —
  #     attachment `hook_cancelled`, `timedOut: true`, `timeoutMs: 30000`.
  #   • PostToolUse: a hook sleeping 300s was NOT cancelled at all — the turn
  #     took 318s end to end and no `timedOut` was recorded.
  #
  # Two things follow, and the second is why this matters here. Cancelling
  # does NOT kill the process or shorten the wall clock: `durationMs` read
  # 70619 for that 70s sleep, so DURATION ALONE LOOKS EXACTLY LIKE "no
  # timeout" — which is how an earlier draft of this comment concluded there
  # was none. `timedOut`/`timeoutMs`, in the same record, are what settle it.
  # And exceeding the cap DISCARDS THE HOOK'S OUTPUT: the cancelled hook's
  # stderr appeared ZERO times in the transcript. So on a short-capped event a
  # wedged CLI does not delay our warning, it loses it silently — one more
  # reason the check is worth nothing if the spawn can hang.
  #
  # What bounds the damage is this ordering. The marker is on disk before
  # `--version` is ever spawned, so a CLI that wedges costs at most ONE
  # invocation in that session: every later hook sees the marker, skips the
  # check and spawns nothing, even if this one was cancelled mid-spawn. Before
  # `w4` this spawn only happened at SessionStart; it can now land on any
  # event this shim is wired to — `UserPromptSubmit`, the 30s-capped one
  # above, among them — so the exposure moved from "once at startup" to "once
  # per session, possibly mid-turn". Not to "every tool call".
  #
  # If that ever needs closing properly, the lever is `hooks.json`'s per-hook
  # `timeout` field, not shell code here.
  if cli_marker_path && [ ! -e "$cli_marker" ] && ( set -C; : > "$cli_marker" ) 2>/dev/null; then
    check_min_cli_version
  fi
  if [ -n "${cmcv_warned:-}" ]; then
    # The line was printed, so make it audible: exit 1, never 2. Non-blocking
    # on every event — the tool call, prompt or session proceeds exactly as it
    # did when this path exited 0.
    exit 1
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
  # Exit 1 so the line is delivered at all (`w4`, THE DELIVERY DEFECT above).
  # 1, not the relay's own status: whatever the old CLI exited with — 2, in
  # the measured case — would BLOCK the tool call, which is the release
  # blocker this whole branch exists to defuse. 1 is non-blocking on every
  # event, so the session behaves exactly as it did when this exited 0; the
  # only difference is that the user now hears about it.
  exit 1
fi

# Quiet mode: exit 0. The loud/quiet contract governs the message, and with no
# message there is nothing to deliver — a non-zero here would still not block
# (1 never does), but it would post an empty "hook error" notice for a
# condition we deliberately chose not to report on this event. What must NOT
# happen either way is propagating the original status: that is the blocked
# tool call on every turn.
exit 0
