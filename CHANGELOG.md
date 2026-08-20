# Changelog

Notable changes to the `pipeline` Claude Code plugin.

**Entries below `0.97.0` also cover the `@baizor/pipeline` CLI, which used to live in this
repository at `apps/pipeline-cli/` and released from it.** It does not any more — it is
`github.com/IvanMurzak/pipeline` now, with its own changelog and its own `cli-v*` releases.
Historical entries are left exactly as written; only this masthead is updated, because it
describes the file rather than recording anything. Earlier history still is in `git log`.

## plugin 0.99.1 — a stuck hook can no longer hold your session for ten minutes

**Every one of this plugin's ten hooks could stall a turn for up to ten minutes, and none of
them ever set a limit.** `timeout` is a real per-hook field in `hooks.json`, in seconds, and
this file set it nowhere — so every hook inherited Claude Code's default: **600 seconds** on
every event the plugin registers, except `UserPromptSubmit`, which defaults to 30s.
`hooks/run-hook.sh` had already named the remedy in its own comments — *"the lever is
`hooks.json`'s per-hook `timeout` field, not shell code here"* — and nobody had pulled it. All
ten now carry one.

**What a timeout does here is narrower than it sounds, and an explicit `timeout` does not behave
like the default cap.** Under the *default* cap, expiry is abandonment: `run-hook.sh` measured a
hook sleeping 70 s under a 30 s default cap as cancelled (`timedOut: true`) with its `durationMs`
still reading **70619** — it ran the full 70 seconds. An **explicitly configured** `timeout`, which
is what this release ships, is different: measured directly against Claude Code 2.1.237 with a
`"timeout": 5` on a hook heartbeating every 500 ms, the hook process was **killed 5,375 ms into
its own run**, its post-sleep marker never written, while the session carried on for another
3.5 s.

**The relays survive that anyway, for a structural reason.** The `hook` shape deliberately
*spawns* rather than `exec`s, so the CLI is a **grandchild** of Claude Code. In the same probe —
same 5 s cap, a wrapper reproducing that shape — the wrapper was killed with its end marker
unwritten while **the grandchild ran to completion**: all forty heartbeats across 39 seconds,
writing its own end marker long after the shim was gone. So your turn is released, the hook's
output is discarded, and the relay finishes in the background uninterrupted. That last part is a
property of the spawn-not-`exec` shape, **not** of the timeout — a hook that `exec`ed the relay,
or did the work in the shim itself, *would* be cut off mid-write. A `PreToolUse` timeout does not
block the tool either.

**Nine of the ten get 20 s.** Measured end to end through the shim on a Windows 11 box against a
63 MB transcript: the hot path — `PostToolUse` → analytics — costs **291 ms** alone, **1.24 s**
with eight hooks at once and **4.49 s** with thirty-two, so 20 s is ~4.4× the worst contended
case. Transcript *size* barely matters to analytics (2 KB, 16 MB and 64 MB all land between
150 ms and 550 ms — it tails from a stored byte offset rather than re-reading), and prompt
matching is flat too: 200 pipeline manifests cost no more than one. The department notifier is
**not** the slow relay you might expect — its daemon spawn is detached, so ensuring the daemon
runs costs what skipping it costs (354–1149 ms either way).

**One entry gets 60 s: `SubagentStop` → stats-relay**, and the reason is measured scaling. It is
the only path the CLI's own source declares *unbudgeted* — its `Stop` sibling self-bounds at
`STOP_BUDGET_MS = 4000` and measures under 1.6 s even with fifty stale records, which is why
that sibling sits on the floor. This one's cost scales with **stale records × transcript bytes**,
not either alone:

| `tokens: null` records to reconcile, 63 MB transcript | duration |
| --- | --- |
| 0 | 0.9 s |
| 5 | 1.8 s |
| 20 | 4.6 s |
| 50 | **9.1 s** |
| 20, with eight hooks competing for the box | **11.1 s** |

A `.stats` tree carrying a backlog while a larger transcript is in play extrapolates past 45 s,
so this entry is not put on the floor.

Cancelling any of the ten is safe: each is best-effort telemetry, an abandoned fold just leaves
the record null for a later stop to fill, and none is a blocking control.

**`UserPromptSubmit` is the one cap lowered rather than introduced** — 30 s to 20 s. It holds
your prompt for as long as it runs, and it measured well under 1 s even with 200 manifests.

`tests/hook-run-shim.test.ts` pins these exact values — nine at 20 s and the one 60 s outlier,
named individually — as well as the 5–60 s range, the same way it already guards the
`"shell": "bash"` pin. A hook added later cannot quietly reintroduce the ten-minute exposure,
and the values cannot drift away from the prose that documents them without CI saying so.

Also corrected: `CLAUDE.md` claimed that bumping the plugin version "requires a second commit in
the parent marketplace repo to bump the submodule pointer." It does not, and that line misled a
real release. The marketplace resolves this plugin by `url` + `ref: main` — no submodule, no
pointer, no version pin — so **merging to `main` is the distribution step**. The parent monorepo
does pin this repo as a submodule and does need a pointer bump, but that is development, not
distribution. The two are now stated separately, alongside the `release-cli.yml` workflow that
cuts the `v<version>` tag.

## plugin 0.99.0 — the CLI-version and missing-CLI warnings were invisible; now they are not

**Every warning `hooks/run-hook.sh` has ever printed reached nobody.** All three of them — the
`pipeline` CLI is not installed, the CLI is too old to have a `hook` subcommand at all, and the
CLI is below the plugin's `MIN_CLI_VERSION` floor — wrote one actionable line to stderr and then
exited 0. **Claude Code routes a zero-exit hook's stderr to the debug log only:** not the
transcript, not the user, not Claude. So the line was written, and then discarded, every time.
`0.94.0` shipped the third of them and `0.98.0` recorded it as working. It was not working; it
was inaudible, and nothing in the plugin could have told you so.

**The fix is the exit code, not the wording.** Whenever one of those three paths actually prints
its line it now exits **1**, which Claude Code surfaces in the transcript as a
`hook_non_blocking_error` carrying the text. (A hook that prints nothing still exits 0 — quiet
mode is unchanged, and the two install/upgrade lines are still `--loud`-only.) Measured against
Claude Code 2.1.236 by running real sessions and reading the transcripts back, rather than
inferred from the docs:

| hook exits | its stdout | what the user sees | the relay's own context |
| --- | --- | --- | --- |
| 0 | anything | **nothing** | applied |
| 1 | empty or plain text | the stderr line, as a non-blocking notice | **destroyed** |
| 1 | schema-valid hook JSON | nothing — the JSON decides the outcome and the exit code is ignored | applied |

The last column is why the relays' output shape matters, and it bites on the events where plain
stdout *is* the context channel — `SessionStart` and `UserPromptSubmit`. Two of the five relays
(`department-notifier`, `prompt-match`) do write stdout, and both write schema-valid JSON, so they
land in the bottom row: their payload survives and only our warning is dropped. A relay emitting
plain text would land in the middle row and lose its `additionalContext` instead — so a relay may
return context as JSON, never as bare text.

**Exit 1 never blocks anything.** A PreToolUse hook exiting 1 was measured letting its tool call
run to completion. Exit **2** is the blocking status, and this shim still never produces one of
its own — the only 2 it can emit is a relay's own, propagated verbatim. A `pipeline fix` scope
guard that denies an out-of-scope edit is exactly that case, and it is unchanged.

**The `MIN_CLI_VERSION` check now runs on every hook invocation, not only at SessionStart** — which
is what closes the gap where a plugin upgrade raised the floor mid-session and nothing re-checked
it. `/reload-plugins` activates an upgrade **without a restart and without re-firing
SessionStart**, so the old SessionStart-only check could not see it; a restart was the only thing
that ever re-fired it.

**It costs one `pipeline --version` spawn per session, not one per tool call.** A marker file in
the system temp directory caches the verdict, keyed on the floor itself, the (version-pinned)
plugin root, the resolved CLI path, and the session. Twenty hook invocations produce one spawn and
one line. A raised floor arriving mid-session is a different key, so it re-fires immediately. If
you *upgrade the CLI* mid-session the marker keeps the old verdict and stays quiet until the next
session — deliberately, because silence after a fix is cheap and a false warning is not.

**Nothing about the version-skew classifier changed.** A CLI with no `hook` subcommand is still
identified by a read-only `pipeline hook --help` probe that runs only after a failure, and a relay
that genuinely failed still propagates its own exit code.

## plugin 0.98.0 — every hook pins `bash`, and Git Bash becomes a Windows prerequisite

**All ten command hooks now carry `"shell": "bash"`** ([#124]) — Stop 2, SubagentStop 2,
SessionStart 2, PreToolUse 1, PostToolUse 1, UserPromptSubmit 1, Notification 1. `"shell"` is a
documented sibling of `"type"` and `"command"`; omitted, Claude Code picks Git Bash on Windows and
**falls back to PowerShell when Git Bash is absent**, handing `hooks/run-hook.sh` — which is POSIX
sh — to a shell that cannot execute it. That fallback was measured ([#122]) as either a hang or,
worse, a dispatcher that exits 0 **without running the shim at all**: on PreToolUse that turns a
deny-hook into a permit. macOS and Linux are unaffected; `bash` was already being used there.

**This is a new hard prerequisite on Windows, which is why the version moved a minor.** A Windows
machine now needs Git Bash — [Git for Windows](https://git-scm.com/download/win) bundles it, or
`winget install --id Git.Git -e --source winget`. Without it, **every hook reports a startup error
a few times per session** instead of silently doing nothing. That is the trade the pin buys: an
error you can see and act on, in place of hooks that look installed and quietly never run. It does
not interrupt anything — a hook Claude Code cannot start is a `non_blocking_error`, so the session
and the tool call carry on.

**If Git Bash is installed somewhere non-standard, set `CLAUDE_CODE_GIT_BASH_PATH`.** Detection
probes fixed locations first — that variable, then `C:\Program Files\Git\bin\bash.exe`, then the
`(x86)` variant — and only then derives `..\..\bin\bash.exe` from wherever `git` resolves on
`PATH`. An install whose layout does not match one of those shapes (a Scoop shim is the common
case) is not found *even though `git` itself works fine*. Point the variable at the `bash.exe`
binary itself; a path whose basename is not `bash.exe`/`sh.exe`/`bash`/`sh`, or that does not
exist, is warned about and ignored.

**Do not take Claude Code's suggestion to add `"shell": "powershell"`.** Its "requires bash but
Git Bash was not found" message proposes exactly that, and for this plugin it re-opens the
fail-open path the pin exists to close.

**Visibility is all the pin buys — it does not make hook-based blocking reliable.** A bash-pinned
hook on a Windows machine with no detected Git Bash throws *before* the spawn, outside the spawn's
own try, and the hook runner classifies that as `non_blocking_error` (deduped per event+command
per session). **The tool call still proceeds.** The only outcome that blocks is a hook that
actually ran and exited 2. So a bash-pinned PreToolUse deny-hook on a Git-Bash-less Windows box
still reads as an *allow* — an announced one, rather than one indistinguishable from approval. Do
not build a genuinely blocking PreToolUse hook on top of `hooks.json` expecting the platform to
hold it closed.

**Why a version bump ships with it.** Claude Code caches installed plugins by `name@version` and
never re-fetches on a content change, so the pin would have reached nobody already on `0.97.0`.
CI now also asserts the pin for every registered hook, with a failure message naming the offending
event — previously the only thing guarding it was prose in `hooks.json`, and prose does not fail
CI.

[#122]: https://github.com/IvanMurzak/pipeline-claude/pull/122
[#124]: https://github.com/IvanMurzak/pipeline-claude/pull/124

## plugin 0.97.0 — the embedded CLI copy is deleted; the plugin ships no code

`apps/pipeline-cli/` is **gone** — 229 tracked files, the last of the pre-extraction copy.
This repository is now exactly what `02-extract-cli.md` drew: skills, agents, `hooks.json`
and `hooks/run-hook.sh`. No TypeScript, no `package.json`, no build.

**Users with `@baizor/pipeline` installed should notice nothing.** The hooks stopped calling
the embedded copy in `0.94.0` (`p6`/`p7` — every relay is a `pipeline hook <name>` subcommand
resolved through `run-hook.sh`), and `0.96.0` added the `MIN_CLI_VERSION` SessionStart warning
for a CLI too old to satisfy the skills. This release removes the code those two changes had
already routed around. If you do **not** have the CLI installed, `run-hook.sh` says so with the
install line, as it has since `0.93.0`: `bun add -g @baizor/pipeline`.

Also in this release, all of it fallout from the delete rather than separate work:

- **CI is two jobs, not three.** The `Pipeline CLI` matrix job left with the directory it ran
  in; those suites run in `IvanMurzak/pipeline`'s own CI. `plugin-hooks` and
  `manifest-validation` remain.
- **The release workflow is plugin-only.** Its `cli` target built `@baizor/pipeline` from
  `apps/pipeline-cli/`; that package is released from its own repository now, so the target and
  the `target` input are removed. Nothing here publishes to npm any more, and `id-token: write`
  went with it. The workflow FILE is still named `release-cli.yml` — see its header.
- **`tests/cli-package-self-contained.test.ts` is deleted**, on its own written instruction. It
  guarded that the CLI's tests reached nothing above the CLI package, which is what made this
  delete safe; with the package gone it had nothing to guard, and its first assertion said so by
  name. `tests/hook-run-shim.test.ts` stays and is now the only suite here.
- **Docs sweep.** Source paths that used to read `apps/pipeline-cli/…` now read `<cli>/…`, the
  notation this repo already used for the CLI's own repository. `README.md` no longer claims the
  CLI is bundled or that there is "nothing to install beyond Bun" — there is; it is the CLI.
  `ROADMAP.md` carries a historical banner instead of being rewritten, and `CHANGELOG.md`'s
  own history is untouched.

## plugin 0.96.0 — SessionStart warns about a too-old (but hook-capable) CLI

`hooks/run-hook.sh`'s existing skew mitigation (0.93.0 / [#112]) only catches a CLI that has
**never heard of `hook`** — it classifies that case with a read-only `pipeline hook --help`
probe. It said nothing about a CLI that answers `hook` just fine (so that probe would also
succeed) but is nonetheless **older than what this plugin's skills and agents actually
assume** — `runner: session`'s own `pipeline next --brief-file` preflight (0.95.0) is exactly
that kind of assumption, generalized.

`run-hook.sh` now declares a single **`MIN_CLI_VERSION`** constant and compares the resolved
binary's own `pipeline --version` against it — once per session, on the `--loud` SessionStart
entry only, and only once that entry's own `hook session-relay` call has already succeeded (so
this mechanism and the pre-existing one are structurally disjoint: a CLI old enough to fail the
`hook --help` probe is classified up there and never reaches this check, and a dedicated test
proves the two can never both print in the same session). Too old → one actionable line to
**stderr** naming the upgrade command, matching the channel the not-installed and
no-hook-subcommand lines already use; current or newer → silence; a `--version` output that
doesn't parse as this CLI's real shape (a bare `N.N.N`, checked against an actual install, not
assumed) → treated as **unknown**, reported once, never treated as "too old" and never silently
swallowed.

**Why the manifest doesn't declare this instead.** T-CLI-1 was re-checked at implementation
time: `.claude-plugin/plugin.json`'s schema still has no field for an external prerequisite (its
only dependency mechanism targets other *plugins*), so `MIN_CLI_VERSION` in `run-hook.sh` is the
one place this floor is declared — bump it there, and nowhere else, when a skill starts
depending on a newer CLI feature.

**Channel, stated plainly.** Per Claude Code's hooks docs, a SessionStart hook's stdout becomes
`additionalContext` — text Claude's context can see, not a guaranteed user-visible banner — and
a SessionStart hook cannot block the session either way. This line goes to stderr, deliberately
matching precedent rather than adding a second delivery mechanism; it carries the same caveat the
existing not-installed and no-hook-subcommand lines already carry.

[#112]: https://github.com/IvanMurzak/pipeline-claude/pull/112

## plugin 0.95.0 — a pipeline can ask the main session to drive it

New execution mode **`session`**, selected by the manifest's top-level `runner:` key
(`pipeline.yml`, or v1 `PIPELINE.md` frontmatter). The main Claude Code session calls
`pipeline next` itself and spawns one `step-executor` per action — **no
`pipeline-manager` in the run at all.** Fewest moving parts, one fewer model layer, and
the user watches every step happen in front of them.

The loop lives in `skills/run/references/session-loop.md`, read by `/pipeline:run` only
when the manifest selects the mode. It uses `pipeline next --brief-file`, so each
iteration adds a three-key control object — `{action, brief_file, phase}` — to the main
context instead of an eighteen-member action block; the brief itself is read by the
subagent the action dispatches to, never by the session.

**`manager` is unchanged and remains the default** when `runner:` is absent. Choose it
for anything long: `--brief-file` compresses the requests, not the step reports coming
back, so a long chain still fills the window the user is watching. Two things `session`
does not do, both stated in the skill and both refused loudly rather than guessed:
`execution: parallel` pipelines (a layer's steps and a `merge`'s branches live in the
brief), and per-step `model:` / `effort:` pinning (the caller sets the subagent's model,
and the resolved value is in the brief it may not open).

Requires a `@baizor/pipeline` new enough to know `pipeline next --brief-file`; the mode
preflights for it and refuses with the upgrade command rather than silently handing a
step executor an absent brief path.

## plugin 0.93.0 — the hooks become CLI subcommands

**BREAKING for the plugin's install requirements: `@baizor/pipeline` must now be installed.**
Install it once with `bun add -g @baizor/pipeline` (or `npm i -g @baizor/pipeline`). A session
started without it prints one actionable line naming that command, from the SessionStart hook,
and every hook then degrades to a silent no-op rather than failing.

The five hook relays — `analytics_relay.ts`, `stats_relay.ts`, `session_relay.ts`,
`prompt_match_relay.ts`, `department_notifier_relay.ts` — are **no longer files in this
repository**. They moved into the CLI's own repository ([`IvanMurzak/pipeline`](https://github.com/IvanMurzak/pipeline))
as subcommands:

```
pipeline hook analytics-relay          pipeline hook department-notifier-relay
pipeline hook stats-relay              pipeline hook prompt-match-relay
pipeline hook session-relay
```

`hooks/hooks.json` invokes `run-hook.sh hook <name>` instead of `run-hook.sh <relay>.ts`.

**Why.** The relays imported CLI internals by relative path — `stats_relay.ts` imported
`apps/pipeline-cli/src/lib/stats` and `lib/stats-backfill` — so they would have broken the moment
that directory was deleted, which is where the plugin-thin work is going. And while the plugin
shipped both a copy of the CLI and the relays, a user who had also installed `@baizor/pipeline`
globally had two copies at potentially different versions, with the hooks always running the
plugin's and nothing detecting the divergence. **A hook's version is now the CLI's version by
construction.**

**`hooks/run-hook.sh` survives, unchanged in shape.** It resolves `pipeline` instead of `bun`,
with the same probe order (PATH → `$BUN_INSTALL/bin` → `~/.bun/bin` → `/opt/homebrew/bin` →
`/usr/local/bin`), the same stream passthrough, the same `--loud`-on-SessionStart-only contract,
and the same committed mode 100755. It exists because Claude Code runs hooks through a
non-interactive `/bin/sh` that never sources `~/.zshrc`; that has nothing to do with which binary
sits at the end of the chain.

**An out-of-date CLI can no longer break your session.** Because a hook command is now a
*subcommand name* rather than a file path, it can be **absent** — a user whose plugin updates while
their globally installed `@baizor/pipeline` does not gets `pipeline: unknown command 'hook'` and
**exit 2**, and a non-zero `PreToolUse` exit *blocks the tool call*. That would have been a broken
session on nearly every turn, so `run-hook.sh` now absorbs it:

- the `hook` shape is run **without `exec`** (everything else the shim is asked to run still
  `exec`s), with stdin/stdout/stderr **inherited exactly as before** — no pipe, no buffering, no
  rewriting; the shell simply survives long enough to read the exit code;
- a **zero** exit returns immediately — the normal path costs nothing extra;
- a **non-zero** exit is classified by one read-only question, `pipeline hook --help`: a CLI that
  has the subcommand prints its usage and exits 0, a CLI that does not refuses it. Version skew
  exits **0** — with one actionable upgrade line under `--loud` (SessionStart), silent everywhere
  else, the same contract the not-installed line follows.

**A relay that genuinely failed still fails.** A `PreToolUse` deny is a *correct* non-zero exit
(that is how the `pipeline fix` scope guard refuses out-of-scope edits), so it propagates verbatim
— a blanket `exit 0` would have silently disabled a safety control. That is asserted in both
directions in `tests/hook-run-shim.test.ts`, against two fake CLIs.

**No behaviour changed inside any relay.** Same gates, same events, same journal — including the
deliberate ordering where `Notification` is evaluated BEFORE the `PIPELINE_JOURNAL_ENABLED`
opt-out, under its own `PIPELINE_AWAITING_INPUT_ENABLED`, so a blocked run still shows in
`pipeline logs` for a user with no cloud account.

**Tests moved with the code.** Twelve relay suites now run in the CLI repository's `Pipeline CLI`
CI job (ubuntu + windows). `tests/hook-run-shim.test.ts` stayed here, because the shim and
`hooks.json` are this plugin's. The parent monorepo gained
`tests/cross-repo/hook-subcommand-parity.test.ts` — the new seam, where a name in `hooks.json`
that the CLI does not implement would otherwise be a silent, permanent no-op.

## plugin 0.92.0 / CLI 0.13.0 — the journal stops being named after a deleted app

The previous release deleted the local dashboard but kept the journal it fed, still named after it
in every `PIPELINE_UI_*` variable. This release finishes that: a **clean break, no aliases** — there
were no users of the plugin yet, so there was no installed base to keep compatible.

**Triaged, not bulk-renamed.** Ten `PIPELINE_UI_*` variables existed; only five had live-code
references, and only those five were renamed:

| Old name | New name |
| --- | --- |
| `PIPELINE_UI_ENABLED` | `PIPELINE_JOURNAL_ENABLED` |
| `PIPELINE_UI_DEBUG` | `PIPELINE_JOURNAL_DEBUG` |
| `PIPELINE_UI_TRANSCRIPTS` | `PIPELINE_JOURNAL_TRANSCRIPTS` |
| `PIPELINE_UI_RUN_ID` | `PIPELINE_RUN_ID` |
| `PIPELINE_UI_PARENT_RUN_ID` | `PIPELINE_PARENT_RUN_ID` |

None of the renamed names alias the old ones — setting `PIPELINE_UI_ENABLED` now does nothing.

The other five configured the deleted server/daemon and had already dropped to zero live-code
references at the previous release: `PIPELINE_UI_HOST`, `PIPELINE_UI_TOKEN`,
`PIPELINE_UI_RECLAIM_PORT`, `PIPELINE_UI_WATCHDOG_ENABLED`, `PIPELINE_UI_IDLE_MINUTES`. These are
**deleted outright**, not renamed — renaming a variable nothing reads would have preserved the
fiction that something still does.

Behavior is unchanged: `PIPELINE_JOURNAL_ENABLED` still gates exactly what `PIPELINE_UI_ENABLED`
gated (the `SessionStart`/`PreToolUse`/`PostToolUse`/`SubagentStop`/`Stop` journal hooks and
`pipeline drive`'s session-binding writer), `pipeline logs` still works regardless of it, and
`tests/journal-end-to-end.test.ts` — which spawns the real hooks as real subprocesses and drives
the real outbox — still passes under the new names.

## plugin 0.91.0 / CLI 0.12.0 — the local dashboard is gone; the journal it was built for is not

The plugin shipped a local web dashboard: a background Bun daemon, a committed React bundle, a
`SessionStart` hook that launched it, `pipeline ui`, and `/pipeline:ui`. All of it is **deleted**.
The hosted dashboard at [ai-pipeline.dev](https://ai-pipeline.dev) is the UI — it is installable as
a web app, and it is already better at the shared 90%.

Nothing was lost in the gap. The two local capabilities with no cloud equivalent moved into the CLI
**before** the deletion: `pipeline logs --chat <run-id>` renders a headless run's transcript in the
terminal, and `pipeline fix` is the browser's AI Fix as a command. Both are offline and upload
nothing. The browser pipeline editor and the voice-input proxy were deliberately dropped.

**The event journal stays, and this is the part worth reading twice.**
`<project>/.pipeline/.runtime/events.jsonl` was built for that dashboard and is still named after it
in every `PIPELINE_UI_*` variable — but it is now the telemetry source: the outbox tails it, the
uploader ships it, and `pipeline logs` renders it for anyone who has declined the cloud. Every
writer survived; only the reader and the app went. `tests/journal-end-to-end.test.ts` drives the
real hook scripts as real subprocesses and then feeds the journal they produce through the real
outbox and uploader, because a journal that silently stopped being written would not have failed
anything — it would just have been empty.

### What changed for you

- `pipeline ui` and `/pipeline:ui` no longer exist. `pipeline logs -f` is the live terminal view;
  `pipeline logs --chat <run-id>` is the post-mortem.
- No background daemon is started on session start any more, and nothing listens on a local port.
  `PIPELINE_UI_HOST`, `PIPELINE_UI_TOKEN`, `PIPELINE_UI_IDLE_MINUTES`, `PIPELINE_UI_WATCHDOG_ENABLED`
  and the `PIPELINE_STT_*` / `OPENAI_API_KEY` / `GROQ_API_KEY` dictation settings are gone with it.
- `PIPELINE_UI_ENABLED` and `PIPELINE_UI_TRANSCRIPTS` keep working unchanged — they now gate the
  journal hooks rather than a UI. The names are a leftover and are being renamed separately.
- **A dead run is no longer swept locally.** The daemon retired runs that had died without a terminal
  event; the signals it keyed on (`manager.stopped`, the `.alive` pid lockfile) are all still
  emitted, but nothing consumes them on your machine. The cloud dashboard does its own liveness.
- `--no-ui` on `pipeline init` remains accepted as a no-op, with an updated message.

### Docs

`apps/pipeline-ui/EVENTS.md` moved to `docs/events.md` and `docs/ui-subsystem.md` became
`docs/journal-and-hooks.md` — the schema and the hook invariants are unchanged, they just no longer
live inside a deleted app.

## plugin 0.90.0 / CLI 0.11.0 — a step is a name, and a connected run reports itself

Two independent bodies of work ship together here. These version numbers were bumped when the
manifest work landed and then held for the owner, so neither was ever published — this is the first
build carrying either. The first half below changes how a pipeline is **defined**; the second
changes what a run **sends**.

### Telemetry: a connected run reports itself, and you can ask what it sent

A local run's measurements never reached the dashboard. The journal on disk was complete and the
cloud had an ingest endpoint, but nothing joined them — so connecting a project bought you a page
that stayed empty while runs finished on your machine.

**Nothing leaves an unconnected machine.** The uploader refuses to build a request body without a
credential, and the org it uploads to is the one the CREDENTIAL authenticates to, never the one
`.pipeline/cloud.json` happens to name — so telemetry queued offline under one org cannot surface in
another's dashboard after you switch. Every payload is filtered through an allowlist before it is
queued and again at the wire; an unrecognized privacy tier fails CLOSED to the most restrictive one.

- **One place mints an id.** `ids.ts` is a hand-rolled RFC 9562 UUIDv7 with §6.2 Method 1
  monotonicity, so run ids sort by creation time — and `pipeline id` is the only sanctioned way to
  get one, rather than each skill inventing a format. Every step gets its own UUID at start, carried
  on events and on `runs.jsonl`, and a **sequential** step now reports its manifest `step_name` too,
  so a rollup row names the step instead of `step:<index>`.
- **The outbox is durable, org-tagged and bounded.** Journal → filtered records → a size-capped
  on-disk queue with a rotation-safe cursor, which outlives the run that wrote it.
- **The uploader cannot fail, delay, or alter a run.** It lives in a DETACHED per-project daemon
  (atomic `wx` lock, one per project) — never in a hook, never on a step's critical path. Each
  request carries a 5 s timeout, each flush a 20 s wall-clock deadline with backoff clamped to the
  time remaining, and at most 20 requests. A flush therefore terminates against any server
  behaviour, including one that hangs forever.
- **`pipeline drive` prints the run's dashboard link before step 1** and tails telemetry in-process
  as the run proceeds, reading `stream-json` output from all four spawn templates.
- **`pipeline stats telemetry [--drain] [--json]`** answers what the subsystem previously left
  unanswerable: whether it is enabled and connected, to which org and project, whether the daemon is
  alive, how much is queued, how much was blocked or dropped and why, and what the last error was.
- **Connecting backfills the runs already on disk**, instead of starting your history at zero.
- **The credential is protected at rest and expires on inactivity.** The refresh token goes to the
  platform's own secret store where one exists (macOS `security`, Linux `secret-tool`); the file
  fallback is written atomically at mode 0600 with a Windows ACL lockdown, and it expires on the
  same inactivity window the server enforces.
- **The project fingerprint is keyed by a per-install secret** — 32 CSPRNG bytes created on first
  use and stored beside the credential — replacing a documented PUBLIC constant that left the
  fingerprint dictionary-attackable for any guessable git remote or path. It is pseudonymous, never
  anonymous, and the module now says so plainly.
- **Security fix:** `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` is deleted from every `claude -p` child
  environment, so a subagent's raw text cannot be forwarded out of a spawned step.

### A step is a name, not a file

A pipeline's definition used to be spread across sources that disagreed about who was in charge:
`PIPELINE.md` frontmatter, every step file's own frontmatter, a `## Graph` section whose mere
PRESENCE silently overrode `execution:`, the numeric filename prefix that actually ordered the
steps, and each step reporting its own successor at runtime — where reporting none ended the run
as `completed`, a silent success.

One file replaces all of it. `pipeline.yml` declares every step, in order, and **a step is an entry
in it identified by `name:`** — nothing about a step comes from disk. An unknown value is an error,
never a warning with a silent fallback.

**Your v1 pipelines keep running.** `pipeline migrate --to-manifest --root <dir>` generates the
manifest and prints the old→new step-name map; a v1 pipeline says so once per run and names that
command. Nothing is removed in this release.

- **The engine resolves steps by NAME.** A parked run now survives its body file being renamed —
  before, the cursor pointed at a file that no longer existed and the run silently restarted at
  step 1. Two steps may share one body, which was impossible when a path was the identity.
- **`--start` takes a step name.** A path still resolves, with a warning naming the step to use.
- **A step's prompt can be COMPOSED** from several markdown files in declared order, optionally
  conditional on flags an earlier step reported. The paragraph every step needs now lives in one
  place instead of being copied into each of them.
- **The manifest decides the order.** A step that reports no successor no longer ends the run as a
  silent success. `PIPELINE_COMPLETE` still works — ending early stays the step's decision — and a
  reported path that disagrees with the manifest gets a warning naming the stale `## Next` section.
- **`self_improve: false` is enforced by the engine**, not asked of the improver: a frozen step's
  brief is never queued. One veto freezes a FILE, so a `_shared/` fragment a frozen step composes
  cannot be edited through an unfrozen one. `pipeline.yml` is always frozen — it changes what the
  run DOES, not what a step is told. Freezing does not silence a step's problems; the retrospective
  still reports them.
- **`/pipeline:run` takes a pipeline folder.** A paragraph of path-walking heuristics is gone.
- **Event schema v5** renames the iteration events' `step_id` to `step_name`. Every reader folds
  `step_name ?? step_id`, so journals already on disk keep folding to identical numbers.

BREAKING, and deliberately loud rather than silent: a run persisted by an older CLI **refuses to
resume**, with a message saying why and to start a fresh run. Its cursor names a file and this
engine dispatches by name; quietly mapping one to the other is exactly the coupling being removed.

## plugin 0.85.5 — the supervisor upgrades itself

A version handoff upgraded the WORKER only. The supervisor kept running whatever code it booted
with for as long as the machine stayed up, so a fix inside `supervisor.ts` could never reach anyone
who already had a daemon running — and the SessionStart hook could not see the problem either,
because the lock only ever reported the worker's install. Seen live during 0.85.1: a worker on
0.85.1 supervised by a 0.85.0 supervisor, hours after the upgrade, which is exactly why that
release's hidden-console fix appeared not to have shipped.

The handoff request already names the new worker script, and the new supervisor is its sibling — so
the outgoing supervisor had everything it needed to hand over all along.

- **A version handoff now replaces the whole daemon.** The outgoing supervisor spawns the successor
  from the new install (detached, hidden, same log files), passes it the port to reclaim so open
  browser tabs survive, and exits WITHOUT spawning a worker — the successor does that. Since the
  worker already discovers a new install by itself (its 30s poll + the `installed_plugins.json`
  watcher), an upgrade now propagates end-to-end with no session restart and no user action.
- **The port travels with the handoff** in the supervisor's own variable, not the worker-scoped
  `PIPELINE_UI_RECLAIM_PORT` — that one is deliberately ignored for a first worker, so reusing it
  would have silently done nothing.
- **The lock reports `supervisor_root`.** The SessionStart hook reconciles on it, so a supervisor
  left behind on an older install is fixed even when the worker is already current — the one state
  the old check could not represent.
- **Falls back to the previous behaviour** when there is nothing to replace (same install) or the
  successor script is missing: the supervisor just spawns the new worker, exactly as before.

Verified on two real installs: boot from A, hand off to B, and B's supervisor takes over with a
healthy worker on the reclaimed port running B's code, while A's supervisor exits.

## plugin 0.85.4 — a run's measurements outlive the worktree it ran in

Run a pipeline from inside a git worktree and its measurements were written into that worktree —
`<worktree>/.pipeline/.stats/<pipeline>/…` — so `git worktree remove` destroyed them at
exactly the moment the run they measured finished. They were unreadable even while they existed:
every reader (the dashboard's stats sweep, the Stop-hook token backfill, `pipeline stats`) resolves
a project through the worktree-to-main mapping and so only ever looked in the main checkout.

The CLI already applies the right rule to worktrees it creates itself — for an `isolation: external`
run the bookkeeping is main-scoped (D6). This extends the same rule to a worktree the CLI did not
create: Claude Code's own worktree sessions, parallel-wave worktrees, `.claude/worktrees/<name>/`.

- **`.stats` is anchored to the MAIN checkout.** A pipeline root inside a worktree resolves to its
  equivalent in the main working tree, so `runs.jsonl`, `SUMMARY.md` and the per-run
  `runs/<id>.log` timeline are written once, in the surviving project, whichever checkout executed
  the run. Verified end to end: run inside a worktree, `git worktree remove --force`, artifacts
  still there.
- **The readers were moved with the writer.** `findStatsProjectRoot` — the one walk the Stop-hook
  relay and the run-init kick both use — maps a worktree checkout to its main one too. Without
  that half, a worktree run's records would be written in one place and enriched in another, which
  is to say never enriched at all.
- **Unchanged: `.runtime/<run>/`** (next.json, records, outputs, the attempt ledger). That is the
  run's live state, its lifetime genuinely is the worktree's, and for an external run it is
  deliberately gitignored inside the worktree so finalize cannot commit it. The events journal was
  already main-anchored and stays so.

## plugin 0.85.3 — a worktree of a submodule is the same project again

A worktree of a SUBMODULE registered as its own project, at a path no checkout lives at.

`resolveProjectRoot` follows a worktree's `commondir` and treats the result's parent as the main
working tree when it ends in `.git`. For a submodule worktree it does not: commondir resolves to
`<repo>/.git/modules/<name>`, a module directory, and every copy of the resolver returned that
path verbatim. Two such entries were live in a 174-project registry, for example
`C:/Projects/AI/ai-pipeline/.git/modules/public/ai-pipeline-plugin` — a "project" that is
neither the submodule's checkout nor the worktree, and that no other session ever joins.

- **Submodule worktrees fold into the submodule's own checkout.** Git records it in the module
  directory as `core.worktree`; the resolver now reads it, so `…/public/ai-pipeline-plugin` and any
  worktree of it are one project with the worktree carried as a tag, exactly like a worktree of a
  plain repo already was.
- **When the checkout cannot be determined** (no `core.worktree`), the worktree stands alone as its
  own project instead of registering a path inside `.git`.
- **Registry entries rooted inside `.git` are pruned** at boot alongside the vanished ones, so the
  bogus projects an older build recorded disappear and re-register correctly.
- The fix is applied to all five copies of the resolver (the canonical one, three hooks, and the
  CLI's), and the parity test now runs four of them for real, adds submodule fixtures, and greps
  all five sources so a copy cannot be silently missed again.

## plugin 0.85.2 — the minute sweep stops re-reading 70 MB of journals it has already read

0.85.1 stopped the daemon walking projects that no longer exist. This one stops it re-reading the
ones that do. The 60-second sweep read and JSON-parsed EVERY shard of EVERY project's journal —
71 MB on a real machine, 35 MB of it a single project — with `readFileSync` + `split("
")`, which
is a UTF-16 copy of the file plus an array of every line. Measured on the running daemon: an
846 MB working-set spike (1056 MB private) once a minute against a 154 MB baseline.

- **The journal walk is streamed.** `streamJournalLines` reads in 256 KB chunks with a carried
  partial line and a streaming UTF-8 decoder, so a multi-byte character on a chunk boundary
  survives intact. This was already flagged in the source as a follow-up. Measured over the two
  real 64 MB journals, folding the same 212,126 events to the same result: peak RSS 284 MB → 158 MB,
  and slightly faster (208 ms → 182 ms).
- **A project whose journal has not moved is not swept at all.** The manager-stopped sweep is a
  pure function of the journal, so its verdict cannot change while the file does not — unless it
  left a decision pending (a `manager.stopped` whose driver may still die), which is tracked and
  keeps that project on the every-minute path. Idle projects now cost one `stat` per shard.
- **Journal poll interval 1 s → 2 s.**

Between the two releases the fold does not touch idle journals at all, and the journals it does
touch cost about half of what they did.

## plugin 0.85.1 — the dashboard daemon stops paying for every project the machine has ever seen

The pipeline-ui daemon polled EVERY registered project every 400 ms, and swept each one four
times a minute. Nothing ever removed a project from its registry — the SessionStart hook adds one
and it stays for the life of the machine — so an install that has run the test suites a few times
accumulates thousands of deleted temp directories and keeps walking all of them. Measured on a
real machine: 666 registered projects, 494 of them already gone; ~1.6k filesystem calls a second,
three quarters of them on paths that could not produce an event, every one through the AV filter
driver. The worker held 5.8% of a core continuously and sawtoothed ~490 MB every 60 s
(139 MB → 615 MB → 139 MB).

It was never a leak — baseline memory and handle counts are flat — but the cost grew with
accumulated history rather than with work, and it survived reboots because the registry is a file.

- **The registry is pruned.** Entries whose project root no longer exists are dropped at boot and
  every 30 minutes, tearing down their watchers, journal tail and cache entries with them.
  Re-registration is automatic on the next session in that directory, so a temporarily unreachable
  root costs one re-add and nothing else.
- **The journal poll is tiered, and its tick is 1 s** (was 400 ms). A project whose journal moved
  in the last 5 minutes is polled every tick; the quiet majority is visited on a cold sweep every
  5th tick. `fs.watch` still delivers the fast path — the poll is only its Windows safety net.
- **Per-project caches are capped.** The per-run caches were already bounded; the per-project ones
  were implicitly bounded by "how many projects can there be", which turned out to be 666.
- **The machine-global bindings journal is compacted** at boot and every 6 hours, keeping its
  newest records. It is append-only, nothing trimmed it, and it had reached 6.5 MB / 11,755 lines —
  which the daemon re-parses whenever it is asked about a run it has not indexed yet. The mirror
  tailer's read offset is resynced with the rewritten file so it never re-emits what it already
  mirrored.
- **The worker's console is created hidden** — it is spawned through `node:child_process` with
  `windowsHide` rather than `Bun.spawn`, which has no such option. Hygiene for a detached child,
  matching what the SessionStart hook already does for the supervisor.

## CLI 0.8.0 — the department surface a whole epic of fixes, and a starter pipeline that costs one step less

The first CLI release since 0.7.0, carrying seven merged PRs plus the starter-template change
below. Every `pipeline department` verb is affected, so upgrade before filing anything against
0.7.0's behaviour.

- **`serve` can bring a `claude-code` department online at all** (x32). It could not: `serve` kept
  its own list of servable adapters, that list went stale when the engine module shipped, and the
  command printed `✓ engine claude-code (supported)` and then refused the same manifest one screen
  later. There is now ONE predicate behind both sentences.
- **`serve --foreground` no longer calls a live local department "served from somewhere else"**
  and exit 1 on a successful register+bind (x39), and `serve` verifies "● online" instead of
  asserting it — a stopped supervisor used to still print it (x13).
- **`status` shows who asked and what ran it** (x19/x44), read by shelling
  `pipeline-runner journal` so it works when the runner service runs as another account —
  previously every task rendered `?` on the happy path (x22). It also learned the machine-credential
  rung, so a no-human setup no longer reads as permanently "offline" (x50), and every offline
  fallback now states its reason.
- **`retire` deletes in the cloud FIRST and unbinds locally only after** (x49). The old order left
  a refused delete with the department callable in the cloud and unserved on the machine.
- **`validate` reports the required `runtime:` fields from the engine registry** (x51), so it can
  no longer accept a manifest `serve` refuses one command later, and it names what it structurally
  could not check.
- **Terminology:** `mesh`/`fleet` are gone from the CLI surface (a11). `pipeline mesh notify` still
  works as a hidden deprecated alias for `pipeline department notify`.
- **`support-answer` step 01 is now a `type: script` step.** Retrieval is deterministic software,
  so it runs in-process with no agent and no LLM tokens — roughly 10–20k tokens off every run of
  the starter pipeline. Steps 02 and 03 are unchanged and read the same output file. Routing moved
  into a `## Graph` block, which is what lets a shipped template have a script step at all (a
  sequential one needs an absolute `## Next`, and a template cannot know its own future path).

## plugin 0.85.0 — the MCP server rename reaches installed users; install is `pipeline init`

Two things, one of which is not a documentation change despite living in a documentation release.

- **⚠ `/mcp` needs approving once more.** The `mcpServers` key rename `ai-pipeline-mesh` →
  `ai-pipeline-departments` (the a11 entry below) landed in `main` with **no version bump**, and
  Claude Code caches an installed plugin by `name@version` — so every already-installed user kept
  the old manifest and the old server key, verified live (`claude mcp list` after `pipeline init`
  still reported the legacy key). **This version is what actually ships it.** Because the key is
  embedded in every tool's callable name and stored OAuth grants are keyed by it, the renamed entry
  is a NEW server with no grant: run `/mcp` and approve once. Nothing else about the connection
  changes. Update the old name anywhere you carry it by hand — `permissions.allow`, a skill's
  `allowed-tools`, a subagent's `tools`, a hook matcher. The control plane's own `serverInfo.name`
  was renamed to match in the same release train, so both halves now agree in the field.
- **`README.md` (a12).** The install section leads with `bun add -g @baizor/pipeline` +
  `pipeline init` — one command that installs the plugin, clones a starter pipeline, starts the
  dashboard and offers to run it — with the two `/plugin` slash commands kept as the manual
  alternative for someone who already has the CLI. The departments section now points at the five
  path pages on ai-pipeline.dev instead of restating them, and documents the
  `pipeline department new` / `validate` / `serve` / `status` / `stop` / `retire` verbs that had
  never appeared in the README at all. No other section changed.

Nothing is published to npm by this release: `@baizor/pipeline` stays at 0.7.0 until the
publish hold lifts, so the globally installed CLI and the copy bundled in this plugin are at
different versions on purpose.

## Terminology rename: "mesh"/"fleet" are gone (simplified-onboarding a11)

**Landed in `main` without a version bump; released in plugin 0.85.0 above** — the note below was
written when this entry documented an unreleased code change. Per the owner directive recorded in
`08-terminology.md`/D10/D31, "mesh"
and "fleet" no longer appear anywhere a user reads them:

- **Command:** `pipeline mesh notify` → `pipeline department notify`. The old spelling still works —
  `pipeline mesh notify` is now a hidden, deprecated alias that prints a warning on stderr naming the
  new command, then behaves identically. Scripts and service definitions written against it keep
  working unchanged.
- **Environment variable:** `PIPELINE_MESH_NOTIFY_ENABLED` → `PIPELINE_DEPARTMENT_NOTIFY_ENABLED`. The
  old name is still read as a fallback (with a deprecation warning) when the new one is unset.
- **Files:** `src/lib/mesh-notify.ts` → `src/lib/department-notify.ts`, `src/commands/mesh.ts` →
  `src/commands/department-notify.ts` (a new, thin `src/commands/mesh.ts` now holds only the
  deprecated-alias shim), `hooks/mesh_notifier_relay.ts` → `hooks/department_notifier_relay.ts`,
  `docs/mesh-mcp.md` → `docs/departments-mcp.md`.
- **Prose:** every user-facing string in the CLI, `README.md`, `CLAUDE.md`, and the docs — OS
  notification titles now read "Department task …" instead of "Mesh task …", and the SessionStart
  hook's injected context says "department task update" instead of "department-mesh task update".
- **⚠ Re-consent — shipped in plugin 0.85.0, not in the commit that made this change:**
  `.claude-plugin/plugin.json`'s `mcpServers` key changes from `ai-pipeline-mesh` to
  `ai-pipeline-departments`. Because that key is embedded in every tool's callable name
  (`mcp__plugin_<plugin>_<server>__<tool>`) and stored OAuth grants are keyed by it, this is a
  one-time, unavoidable cost: **every already-connected user needs to run `/mcp` and approve again
  once**. Nothing else about the connection changes. The commit that renamed the key did not bump
  `version`, so installed users kept the old one until 0.85.0 — see the entry at the top of this
  file.

Deliberately NOT renamed: prose inside `.claude/design/**` (the design ledger keeps its original
wording — D17), citations to files in the private `cloud/` repo whose own tier-2 rename has not
landed yet (`mesh-oauth/…`, `mesh-registry/…`, `mesh/routes.ts`, …), and citations to the `pipeline-runner`
sibling repo's own `core/mesh-oauth.ts` (a separate repo's own rename, out of this task's scope).

## Drive record contract on Claude Code >= 2.1.21x + parked-run journaling (e7 kill-drill DEFECT-1 / DEFECT-3)

**CLI 0.3.1** (owner-approved patch release; plugin version unchanged at 0.75.0). Both defects
surfaced in the fix-fundamental-issues e7 kill-drill and blocked the design's prod GO; the
fixes were re-drill-verified end-to-end (all four drill defects dead) before this release.

### Fixed

- **DEFECT-1 (BLOCKER): `pipeline drive`'s executor record contract was dead on current Claude
  Code.** Empirically verified on 2.1.214: (a) a `-p --agent <name>` run returns NO
  `structured_output` — `--json-schema` is silently ignored for subagent runs (upstream
  claude-code#20625); (b) headless `--permission-mode acceptEdits` auto-DENIES every Write under
  `.claude/` as a sensitive path, and NO `--allowedTools`/`permissions.allow` rule overrides it
  (claude-code#66525 — "not planned"), so the canonical
  `.runtime/<run>/records/` file never landed either. Net effect: every agent step did its work,
  then drive halted with "no valid step record (executor exit 0)". The fix keeps the security
  posture (no permission-mode weakening, no bypass) and restores the record through a
  **belt-and-braces channel ladder**:
  1. `structured_output` (authoritative where `--json-schema` still works — <= 2.1.205 behavior
     unchanged);
  2. a per-run tmp **record DROP file** the prompt now names
     (`<os-tmpdir>/pipeline-drive/<rootHash8>-<run>/records/<step>.json`), granted to the claude
     sandbox via the new `--add-dir {record_dir}` template token — the narrowest grant that is
     empirically writable under headless acceptEdits (probed: allow rules and `--add-dir` into
     `.claude/` are both refused; an added tmp dir is accepted);
  3. the legacy canonical record file (custom templates / sessions parked under an older CLI);
  4. the final-response text parsed as a JSON object (`lib/envelope.ts parseResultObject`;
     the hardened headless prompt demands the exact record object as the final response).
  Whichever channel wins, drive persists the canonical `.runtime/<run>/records/` copy ITSELF, so
  every downstream consumer path is unchanged. Templates without `{record_dir}` get the
  `--add-dir` pair appended for step spawns (the `{session}` convention). Headless
  improver/script-creator sessions gain the same result-text recovery (they were taking the
  conservative `applied:false`/`refused` fallback on EVERY run on 2.1.21x).
- **DEFECT-1 DoD — denied-write triage:** the envelope's `permission_denials` are parsed
  (`lib/envelope.ts`), and a no-record halt whose denials name a record path now says
  "record write DENIED by the claude permission gate (<path>)" (plus a live
  `step.record_write_denied` progress event) — distinguishable from "the executor produced no
  record" in logs and stats.
- **DEFECT-3: `pipeline drive` never journalled the `awaiting_input` event**, so a parked
  cloud-dispatched run looked `running` server-side — the sweeper's HOLD disposition was
  unreachable and a parked run would be re-dispatched on lease death (design-forbidden). Drive
  now journals `awaiting_input` at EVERY exit-4 park (agent-step questions AND approval gates,
  first parks AND repeat re-entries) with the exact `@baizor/pipeline-protocol`
  `AwaitingInputData` shape the control plane's runs-ingest consumes
  (`{run_id, iteration, question_id, question}` + additive `step_id`/`iteration_path`), and the
  `--resume` re-entry's re-issued `iteration.started` carries the additive `resumed: true`
  (protocol v5 G5) — the ingest's un-park/next-attempt signal. Gate parks gain a STABLE
  deterministic `question_id` (`gate:<run_id>:<step_id>`), now also present in the gate's exit-4
  JSON. New `lib/event.ts emitEventJson` writes structured (nested-object) journal payloads the
  kv interface cannot carry; the journal envelope stays byte-identical (schema stays 4 —
  values-only addition; see `apps/pipeline-ui/EVENTS.md`).

### Tests

- Fake-runner matrix for the ladder (`tests/drive.test.ts`): `{record_dir}` argv handling,
  result-text + fenced recovery, structured-vs-text precedence, legacy-file compat, denied-write
  triage; park/resume journal contents (order, repeat-park re-emission, resumed tagging).
- `tests/awaiting-input-contract.test.ts` — the cloud-consumed `awaiting_input` shape, with the
  consumer's parsing expectations copied in (provenance: protocol `AwaitingInputData` +
  `QuestionSchema` + envelope, cloud `runs/ingest.ts` `awaiting_input` case, runner shipper
  privacy allowlist).
- `tests/drive-claude-smoke.test.ts` — @serial REAL end-to-end smoke against the installed
  claude binary (a one-step `.claude/`-rooted pipeline through the DEFAULT template on haiku):
  proves a record lands under the fixed contract. Skipped on CI / when claude is absent /
  `PIPELINE_SKIP_CLAUDE_SMOKE=1`.

## Headless self-improvement in `pipeline drive`

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

Behavior ships behind `PIPELINE_DRIVE_SELF_IMPROVE`
(**default OFF this release** — owner decision; `0`/unset restores the v1 skip byte-identically).
Requires **claude >= 2.1.205** for reliable `--json-schema` structured output (older versions fall
back to conservative `applied:false`/`refused` records with a warning).

### Added

- **`pipeline drive` now runs real self-improvement instead of the v1 skips** (closing the C1 gap —
  cloud/headless runs never self-improved). `run-improver` / `run-script-creator` spawn pinned
  headless `pipeline:pipeline-improver` / `pipeline:pipeline-script-creator` sessions through the
  same session + crash-resume machinery as steps (session files `sessions/improver-<n>.json` /
  `script-<n>.json`, shared crash budget, usage/cost folded into `usage.json` and the terminal
  `.stats` enrichment; a failed session never halts the chain). Command templates overridable via
  `PIPELINE_DRIVE_IMPROVER_CMD` / `PIPELINE_DRIVE_SCRIPT_CREATOR_CMD`.
- **Mechanical end-of-run retrospective.** Drive partitions `.feedback/<run-id>/*.md` by
  frontmatter `category` itself: doc-actionable (`doc-flaw`/`ambiguity`/`script-candidate`/
  `script-failure`) feed ONE batch improver session + strictly-sequential script-creators;
  human-only (`project-issue`/`env`/`friction`) become one-line summaries in the final JSON's
  `retrospective` field; unknown/unparseable files are counted `skipped` (never a halt). Feedback
  is deleted on success and preserved when the improver session failed — and always preserved on
  blocked/awaiting parks (manager parity).
- **New events**: `improvement.applied` and `run.retrospective` — payloads carry paths + one-line
  summaries ONLY, never file content. Retro-internal `improver.*`/`script_creator.*` events are
  drive-emitted (manager parity).
- **`preserve_workspace: true`** (+ reason) in the terminal JSON when improvements were applied but
  no finalize hook landed them — an ephemeral cloud job checkout must not be torn down with
  unshipped improvements inside (design 05 §Cloud interplay).
- **New `lib/improver-schema.ts`** — the improver/script-creator record JSON Schemas
  (`{applied, script_creation_briefs[], summary}` / `{outcome, script_path, summary}`), single
  source for the headless sessions' `--json-schema` and the engine's ScriptRecord vocabulary.
- **Step-record schema carries `improvement_brief`** (additive, optional) so the structured-output
  path delivers the Tier-1 brief to the driver — the record-FILE protocol already had it.

### Changed (behavior)

- On a worktree-scoped external run, drive's step prompts now derive `pipeline_root` (and the
  Tier-2 feedback dir) from the surfaced `worktree_pipeline_root` — matching the manager contract,
  so executors journal where the worktree-scoped retrospective gate counts and improver edits ride
  the run's finalize commit by construction. Unscoped runs are unchanged.

## Worktree-scoped pipeline I/O (`isolation: external`)

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

Behavior ships behind `PIPELINE_WORKTREE_SCOPED` (default ON).

### Changed (behavior)

- **External-isolation runs now execute the pipeline definition from the RUN WORKTREE — committed
  state only.** `pipeline next` provisions the worktree at init (before plan computation) and plans
  from `<worktree>/<pipeline-root-rel>`: a branch that modifies its own pipeline runs ITS version,
  and dispatch paths, rendered copies, script executions, outputs, ledgers, and per-run feedback
  all live under the worktree's pipeline tree. Because a worktree materializes commits only,
  **uncommitted pipeline edits in the main tree no longer reach an external run** — the engine
  emits a loud preflight warning when the main pipeline dir is dirty (commit first, or set
  `PIPELINE_WORKTREE_SCOPED=0` for the legacy main-scoped reads, restored byte-identically).
- **Self-improvement edits ride the run's finalize commit/PR instead of dirtying main.** The
  improver/script-creator/retrospective targets are worktree paths; `.gitignore` stubs written in
  the worktree pipeline tree (`.runtime/`, `.feedback/`) keep run artifacts out of the finalize
  commit. On a halted run the preserved worktree keeps the edits for inspection.
- **Run bookkeeping stays main-scoped**: `next.json` (crash/blocker resume survives teardown), the
  events journal, `.stats`, and liveness remain under the main root; events/stats/UI are labeled
  with the stable MAIN author paths via a `(worktree_prefix, main_prefix)` swap recorded in
  `next.json`. The flag itself is FROZEN per run at init — a mid-run env flip can never mix path
  models within one run.
- **Init-failure teardown**: an invalid worktree pipeline plan right after provisioning runs the
  destroy hook with `outcome: halted` (preserve-on-halt cue applies) — an invalid plan never
  silently leaks a worktree.
- Native-parallel and in-place (`manual`) isolation modes are UNCHANGED; composed child runs and
  `--manual-hooks` runs stay main-scoped.

## Bounded agent-step retries (`retries:` on `type: agent` steps)

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **`retries:` frontmatter is now honored on `type: agent` steps** (previously script-step-only):
  a transiently-halted agent step — an executor failure, not a domain `blocked-delegating` or
  depth-ceiling outcome — re-dispatches in a **fresh executor** (a brand-new spawn with its own
  context, not a resume) up to `retries:` times before the run actually halts. Default `0` (omit
  the key ⇒ today's behavior, byte-identical: halt on the first failure). Retry re-dispatches
  carry an additive `retry: n` tag on `iteration.started`; an intermediate halted attempt never
  feeds graph route counters — only the final outcome routes. A mid-retry crash resumes with the
  same retry tag intact (`resumeRun` gained a crash twin beside `pending_fallback`).
- **Sequential steps only in v1** — `retries:` parses harmlessly on a parallel-layer member but is
  structurally never consulted there (layer results arrive as a single `{kind:'layer'}` record,
  never through the per-step retry seam); give the step a `depends-on` fan-in to move it to a
  sequential layer if it needs bounded retries.
- **New plan-time lint (08.5)**: warns when a parallel-layer member's iteration body mentions
  needs-input phrasing, since every layer dispatch runs with `allowInput:false` regardless of
  layer size (companion to the a3 designer self-contained-parallel-steps rule).

### Changed (behavior)

- The script-only ignored-frontmatter warning on agent steps (`script`, `command`, `timeout`,
  `on-failure`) no longer lists `retries` — it now has its own, distinct agent-step meaning and is
  honored on both step kinds.

## `pipeline drive`: correlatable park IDs, provider-limit detection, executor retry env

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **Top-level `question_id` in the exit-4 (awaiting-input) JSON and persisted session state** —
  minted at park time (06.2.1) so a cloud dispatcher can correlate a parked question across
  restarts without inferring one from nested fields; `--resume --answer` delivers against the SAME
  id.
- **`provider_limit` in the exit-1 (halted) JSON** when the executor envelope indicates a
  provider-side rate-limit or overload (`error_rate_limited` / `error_overloaded`) — shape
  `{reason: "rate_limit_exceeded" | "overloaded", retry_after_ms?}` — so a retry policy can tell
  "the model provider throttled us" apart from every other halt cause (06.7).
- **Executor retry environment (08.4)**: `drive` now sets `CLAUDE_CODE_RETRY_WATCHDOG=1` and
  `CLAUDE_CODE_MAX_RETRIES=15` on every spawned executor (the documented unattended-session
  mechanism, Claude Code 2.1.199+), lifting the transient-retry cap so a flaky provider blip
  doesn't halt the run. Both are overridable: set either env var before invoking `drive` and your
  value wins.

## `pipeline hash` — cloud-equivalent pipeline content hash

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **New command**: `pipeline hash --root <pipeline_root> [--json]` computes the deterministic
  SHA-256 content hash of a pipeline (`PIPELINE.md` + every file under `steps/**` and
  `scripts/**`) — order-independent (files sorted by POSIX-relative path), rename-sensitive, and
  OS-stable (CRLF→LF normalized by default). Output: `sha256:<hex>` (plain) or
  `{"content_hash":"sha256:<hex>"}` (`--json`). Exit `0` success, `2` on a missing/invalid root.
- This is the SAME identity the cloud registry uses (`registry/hash.ts`, D9) — the runner (c4
  task) shells this exact CLI to verify a lease's content hash before executing. Golden-vector
  tests prove byte-exact equivalence with the cloud registry hash.
- `hashFileSet` (the underlying hashing primitive) is now library-exported for embedding.

## CI, `pipeline gc`, and release-tooling fixes

**Plugin `0.74.4 → 0.75.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.2.2 → 0.3.0`**
(`apps/pipeline-cli/package.json`)

### Fixed

- **`pipeline gc` silently found nothing to collect on Windows CI (8.3 short-path bug, 06.6).**
  `gc`'s worktree-under-root check compared a Windows 8.3 short-name path segment (`RUNNER~1` —
  what `realpathSync` returns on GitHub's `windows-latest` runner image) against git's own
  long-canonical path output, matching nothing: `report.worktrees` / `removed_worktrees` came back
  empty for both the superproject and submodule scans. Fixed by re-anchoring `gc`'s root on `git
  rev-parse --show-toplevel` (the same resolution `git worktree list` / `prune` already use),
  falling back to `realpathSync` only when git can't answer. pipeline-cli's CI job now runs on
  `windows-latest` in addition to `ubuntu-latest` to catch this class of bug pre-release; the
  `submodule-orphan` / `submodule-modes` / `event` tests are marked `@serial` (flaky under N-way
  local parallel-test contention, not under CI's already-sequential run) so the local test runner
  holds them out of its worker pool. Release workflows are untouched — release stays
  `ubuntu-only`.
- **`pipeline release`'s printed checklist referenced a nonexistent step.** It told users to bump
  a "marketplace.json version" field that doesn't exist — this repo self-distributes via
  `.claude-plugin/marketplace.json`'s `source: "./"`, which carries no per-plugin version to
  drift. Removed; the submodule-pointer-bump step (for the parent marketplace repo) is kept.
  Shipped in plugin `0.74.2`; recorded here since it was undocumented until now.

## Pipeline variables (`${PP_*}`)

**Plugin `0.73.0 → 0.74.0`** (`.claude-plugin/plugin.json`) · **CLI `@baizor/pipeline` `0.1.1 → 0.2.0`**
(`apps/pipeline-cli/package.json`)

### Added

- **`## Variables` manifest section.** Declare pipeline-scoped variables in `PIPELINE.md`:
  `- PP_NAME (required) — description` or `- PP_NAME (default: value) — description`. Reference
  one anywhere in iteration/manifest body text, or in a script step's `command:`/`script:`
  frontmatter values and `## Params` `from:` templates, as `${PP_NAME}` — with an optional inline
  fallback `${PP_NAME:-default}` (unset-or-empty) / `${PP_NAME-default}` (unset only, POSIX
  semantics) and a `$$` escape for a literal token in prose.
- **`--var NAME=value` (repeatable) and `--vars-file <path>` (dotenv format)** on `pipeline next`,
  `pipeline drive`, and `pipeline step run`. Values resolve `--var`/`--vars-file` > the operator's
  environment > the manifest `(default: ...)`, are validated fail-fast and aggregated (every
  missing/unknown/malformed variable reported at once, never first-error-only), and are FROZEN
  into the run's state at init on `next`/`drive` — a `--resume` reuses the frozen map verbatim and
  supplying new values against an already-frozen run is a loud usage error (exit 2). `step run`
  resolves the same way but never freezes or persists anything (dry-run only).
- **Rendered per-run copies of agent iterations.** When a pipeline declares variables, `pipeline
  next`/`drive` substitute `${PP_*}` tokens into a per-run rendered copy of each dispatched
  iteration (and `PIPELINE.md`) under `.runtime/<run-id>/rendered/<pipeline-slug>/` — source files
  are never mutated. The rest of the pipeline tree (sibling steps, `scripts/**`, fixtures) mirrors
  into the same rendered tree so relative references between steps keep resolving; only an
  **absolute** reference back to the source tree still sees raw `${PP_*}` placeholders.
- **Script-step integration**: a resolved `PP_*` value substitutes into a script step's `command:`
  argv (never into `argv[0]`, which is forbidden as a substitution surface outright) and `script:`
  path, and every resolved variable also rides the child process environment alongside the
  existing `PIPELINE_STEP_*` contract vars — existing scripts read `os.environ["PP_X"]` /
  `process.env.PP_X` with zero changes to their own invocation. A substituted `script:`/`command:`
  path is containment-checked against the project root, and a substituted value reaching a
  `.bat`/`.cmd` target (or an authored `cmd`/`cmd.exe` command) is refused — those run through
  `cmd.exe`, which re-parses its command line and is not argv-safe.
- Full CLI-flag contract: `docs/cli.md`. Full script-step argv/env/Params contract: `docs/script-steps.md` §2.5.

### Trust model (read before using)

- `PP_*` variable values are **non-secret configuration by contract**: they are visible verbatim
  in rendered files, params files, child-script environments, logs, events, and — for agent
  steps — the step-executor's LLM context. Never design a variable to carry a secret; keep using
  the existing secret channels (worktree env files, or a script reading real secrets straight from
  the process environment). Secret-looking declared names are lint-warned.
- A value substituted into an agent iteration is **untrusted data in that iteration's LLM
  context**, not an authored instruction — the step-executor treats it as data even if its content
  reads like an instruction.
- **Environment-collision footgun**: no registry reserves the `PP_` namespace. A `PP_*` name
  already set in the operator's shell/CI environment silently satisfies a declared variable with
  no flag and no prompt. Check your environment (or pass an explicit `--var`, which always wins)
  before running an unfamiliar pipeline.

### Upgrade / downgrade caveat

- **Do not downgrade the CLI mid-run on a pipeline using variables.** There is no state-format
  version marker in `next.json`. A run started on this version (or newer) freezes its resolved
  `PP_*` map into `next.json`; an OLDER CLI resuming that same run ignores the unknown `variables`
  key entirely and hands the step-executor the **source** iteration file with raw, unsubstituted
  `${PP_*}` placeholders in it instead of the rendered copy — the run will not fail loudly, it will
  silently execute the wrong content. Finish (or abandon) a run on the CLI version it started on;
  upgrading mid-run is safe (an old run with no `variables` key just keeps its pre-upgrade
  behavior), downgrading a variable-using run is not.
- Runs on pipelines with **no** `## Variables` section are entirely unaffected by this release —
  zero behavior change, zero new files, zero new state keys (`E9`).

### Compatibility

- Fully backward compatible: pipelines without a `## Variables` section take the exact same code
  paths as before (no rendering, identical `ActionStep.path`, identical argv, identical env).
- The pre-existing `${steps.x.output.y}` / `${env.NAME}` / `${run.*}` / `${pipeline.root}` /
  `${project.root}` / `${worktree.*}` Params bindings, the `{model}` drive-executor template, and
  `--param` on `step run` are all unchanged and coexist with `${PP_*}`.
