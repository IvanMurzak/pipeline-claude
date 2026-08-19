# CLAUDE.md — pipeline plugin

This file guides Claude Code when working **inside the plugin repository itself** (editing its agents, skills, or docs). For guidance on using the plugin in a consumer project, see `README.md`.

## Plugin layout

```
.claude-plugin/plugin.json          # plugin manifest
agents/
  pipeline-manager.md               # orchestrates ONE run (depth 1, has Agent): spawns a step-executor per iteration, dispatches improver/script-creator; per-iteration events + external worktree hooks are CLI-executed by `pipeline next` (the manager emits only retrospective events)
  step-executor.md                  # executes ONE iteration in a fresh context and reports to the manager (chain leaf; has Agent for intra-step fan-out ONLY) — formerly pipeline-executor
  pipeline-improver.md              # edits existing iteration/manifest docs based on a step-executor-provided improvement brief
  pipeline-script-creator.md        # extracts heavy procedural Steps blocks into Python scripts under <pipeline-root>/scripts/
  pipeline-disambiguator.md         # cheap LLM tiebreaker (Haiku 4.5) — picks one pipeline among 2-5 ambiguous BM25 candidates
skills/
  design/SKILL.md                   # /pipeline:design   — designs pipelines directly
    references/authoring-protocol.md # complete design contract, read by the skill on invocation
  run/SKILL.md                      # /pipeline:run      — spawns pipeline-manager (which spawns step-executors); chains improver and script-creator after each iteration; emits run lifecycle events into the journal
    references/session-loop.md      # `runner: session` — the loop the MAIN SESSION runs itself instead of spawning a pipeline-manager, read by the skill only when the manifest selects that mode
  dispatch/SKILL.md                 # /pipeline:dispatch — three-tier ladder (`pipeline match` → disambiguator/Haiku → main-session chain detection); auto-runs chosen pipeline(s)
  find/SKILL.md                     # /pipeline:find     — deterministic-only match (BM25 + Scope.Out hard-filter); accepts --issue; asks before running
  optimize/SKILL.md                 # /pipeline:optimize — USER-INVOKED ONLY (disable-model-invocation): weekly review of .stats/ measurements → targeted pipeline-improver fixes
# apps/pipeline-cli/ — REMOVED in plugin-thin `p9`. This repository ships NO CODE.
#   The CLI is its own repository: github.com/IvanMurzak/pipeline, published as
#   `@baizor/pipeline`, INSTALLED BY THE USER (`bun add -g @baizor/pipeline`).
#   A ~45-line per-file inventory of its internals used to sit here; it described
#   another repository's tree, which is precisely why it left with the code.
#   ⚠ That inventory has no replacement yet — `IvanMurzak/pipeline` carries no
#   CLAUDE.md of its own (checked at p9). Until it does, the last full copy is in
#   this file's git history (the p9 commit) and in that repo's own docs/ + README.
#   Everything the PLUGIN needs to know about the CLI is a CONTRACT, not an
#   internal, and lives in docs/ below — paths there are written `<cli>/…`.
hooks/
  hooks.json                        # Registers Stop + SubagentStop (matcher: pipeline-manager) + SessionStart + PreToolUse + PostToolUse + UserPromptSubmit + Notification. Every command is `run-hook.sh [--loud] hook <name>` — the relays are CLI SUBCOMMANDS, not files here (plugin-thin p6): they live in github.com/IvanMurzak/pipeline as `<cli>/src/hooks/*.ts`, so a hook's version is the installed CLI's version by construction. THIS PLUGIN THEREFORE REQUIRES `@baizor/pipeline` (`bun add -g @baizor/pipeline`). Registered names: analytics-relay · stats-relay · session-relay · department-notifier-relay · prompt-match-relay
  run-hook.sh                       # POSIX-sh shim every hook command routes through: resolves an absolute `pipeline` binary (PATH → $BUN_INSTALL/bin → ~/.bun/bin → /opt/homebrew/bin → /usr/local/bin) and runs it with stdin/stdout/stderr INHERITED (no pipe, no buffering), because Claude Code runs hooks via non-interactive /bin/sh which never sources ~/.zshrc — the reason `~/.bun/bin` (bun's default macOS install dir) is invisible to a Dock/Finder-launched session. It resolved `bun` until p6 and `pipeline` since, and it must not be deleted. Must stay executable (mode 100755) or the shim itself reintroduces the "command not found" bug it fixes; `--loud` (SessionStart's primary entry only) prints ONE actionable line naming the install command when the CLI is absent, every other call site stays silent to avoid flooding high-frequency hooks. VERSION SKEW: since the arguments are a SUBCOMMAND name, an out-of-date CLI can refuse it (`unknown command 'hook'`, exit 2) and a non-zero PreToolUse exit BLOCKS THE TOOL CALL — so the `hook` shape is no longer `exec`ed (everything else still is): its exit code is inspected, and a non-zero one is classified by a read-only probe, `pipeline hook --help`, which exits 0 on a CLI that has the subcommand and is refused by one that does not. Skew → never the relay's own status (that would block the tool call), and exit 1 + one upgrade line under --loud; a relay that genuinely failed → its exit code PROPAGATES, because a PreToolUse deny is a correct non-zero exit and swallowing it would disable a safety control. DELIVERY (w4, 0.99.0): every warning this file emits exits **1**, never 0 and never 2 — Claude Code routes a ZERO-exit hook's stderr to the debug log only, so all three of these lines reached nobody until 0.99.0; exit 1 surfaces them in the transcript as `hook_non_blocking_error` and blocks nothing, while exit 2 is the blocking status this file never produces of its own. Measured against Claude Code 2.1.236, including a PreToolUse whose tool call still completed. One residual gap, deliberately accepted: if the relay on that invocation wrote schema-valid hook JSON to stdout, Claude Code ignores the exit code and the line is recorded but not surfaced — all five real relays write nothing to stdout on the ordinary path. MINIMUM CLI VERSION (plugin-thin B.2, 0.96.0): the probe above only catches "no `hook` subcommand at all" — it says nothing about a CLI that answers `hook` fine but is still older than a skill assumes. `MIN_CLI_VERSION` is this file's single declared floor (T-CLI-1: plugin.json has no field for it); `check_min_cli_version` compares it against `pipeline --version` on EVERY invocation since w4 (T-CLI-3: `/reload-plugins` activates a raised floor mid-session and does NOT re-fire SessionStart, so a --loud-only check could only ever be re-fired by a restart), still only once the primary `hook` call already succeeded, so it can never fire in the same session as the no-hook-subcommand line above. Flood and spawn cost are held down by a marker file in the system temp dir keyed on the floor + the version-pinned plugin root + the resolved binary + `CLAUDE_CODE_SESSION_ID` (measured present and session-stable in every hook event; `CLAUDE_SESSION_ID` does not exist and `$PPID` is 1, so neither is usable) — 20 invocations cost ONE `--version` spawn and produce ONE line, and a raised floor is a different key so it re-fires at once. Too old → one stderr line naming the upgrade command; current/newer → silence; unparseable `--version` output → reported once as UNKNOWN, never as "too old"
tests/                              # THE PLUGIN'S OWN TESTS, and now the ONLY tests here — `hooks/run-hook.sh` + the `hooks.json` wiring (hook-run-shim.test.ts). The twelve RELAY suites left with the relays in p6 and run in the CLI repo; cli-package-self-contained.test.ts was REMOVED in p9 with the directory it guarded. Run with `cd tests && bun test` (no root package.json and none wanted: a plugin install is a git clone with no install step, so a root manifest would imply one and sit beside .claude-plugin/plugin.json as a second name/version; bun needs no manifest to run a directory). ⚠ NOT `bun test tests/` from the root — a positional arg to `bun test` is a file-NAME filter, not a directory scope; there is less here to collide with since p9, but the form is still wrong. Gated by the `plugin-hooks` CI job. See "Where a test lives" below
docs/                               # On-demand reference docs split out of CLAUDE.md — read before editing the matching subsystem
  cli.md                            #   the `pipeline` CLI — commands & contracts (plan/match/event/route/next/logs/fix/submodule bump)
  execution-modes.md                #   execution modes (DAG/parallel, external isolation + finalize), model selection, EVENTS schema, self-improvement + nested-blocker loops, spawn-depth rules
  journal-and-hooks.md              #   the event journal + the hooks that write it — hard invariants, lockstep rules
  events.md                         #   the event journal's SCHEMA (v5) — envelope, event types, bindings journal (was apps/pipeline-ui/EVENTS.md)
  departments-mcp.md                #   Departments remote MCP entry + background notifier (task a1, renamed from mesh-mcp.md at a11) — connect flow, notifier architecture, transport-deviation rationale, env vars
  nested-blocker-delegation.md      #   blocker_delegation brief fields + the supervisor orchestration flow
  worktree-hook-contract.md         #   FROZEN consumer contract for external-isolation worktree hooks (create/finalize/destroy)
  script-steps.md                   #   FROZEN consumer contract for `type: script` steps (declaration, params/bindings, process I/O, failure ladder, ledger, outputs, `step run`)
  history.md                        #   provenance — where the agents were ported from
README.md
CLAUDE.md
.gitignore
```

## Path resolution rules (critical)

The single most important invariant in this plugin:

- **Pipelines live in the consumer project, not the plugin.** Every pipeline file is written under `<cwd>/.pipeline/` — where `<cwd>` is the consumer project's working directory. The plugin install path (`${CLAUDE_PLUGIN_ROOT}`) is **read-only** at runtime.
- **Absolute paths in iteration files resolve against the consumer project.** When an iteration's `Next` field points to `/.../.pipeline/...`, that path is a location inside the user's project filesystem.
- **Never hardcode a specific project's name or a specific category name in agent docs or skills.** Use generic placeholders like `<pipeline-name>` and `<category>`. The existing `/pipeline:design` skill, `step-executor`, and `pipeline-improver` docs contain no references to any particular project layout — keep it that way.

If you see a concrete path like `unity-project/` or `migrate-auth-module/` appearing in any of these files, replace it with a neutral placeholder. Those are consumer-project choices, not plugin defaults.

## CRITICAL: bump `version` in `plugin.json` on any meaningful change

Claude Code caches installed plugins by `name@version` under
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. It does
NOT re-fetch when the source content changes — only when the version
string in `.claude-plugin/plugin.json` changes.

**Any edit that changes agent behavior, skill instructions, or hook
logic MUST also bump the `version` field.** Without the bump, users
who've already installed the plugin see the old content forever and
every skill invocation loads stale instructions.

Use semver:
- Patch bump (0.2.0 → 0.2.1): bug fixes, doc-only changes, marker
  regex fixes.
- Minor bump (0.2.0 → 0.3.0): new skill, new agent, new hook, new
  template version (e.g., CLAUDE.md stanza v4 → v5).
- Major bump (0.2.0 → 1.0.0): reserved for a stable public release.

Don't forget: bumping here requires a second commit in the parent
marketplace repo to bump the submodule pointer.

## Editing rules

- `skills/design/references/authoring-protocol.md`, `agents/pipeline-manager.md`, `agents/step-executor.md`, `agents/pipeline-improver.md`, and `agents/pipeline-script-creator.md` share the same mental model of pipeline folder structure (PIPELINE.md + steps/ + optional scripts/). When you change one, check the others — invariants, folder-structure diagrams, and path-resolution rules must stay consistent. (`pipeline-disambiguator` is exempt — it never reads files from disk; it just reasons over manifests inlined in its prompt.)
- `design` owns pipeline authoring directly. Keep `SKILL.md` concise and keep the detailed, load-bearing authoring rules in `skills/design/references/authoring-protocol.md`.
- `run` is NOT a thin router — it is the **supervisor**. `/pipeline:run` (main session, depth 0) mints the run id, owns UI liveness + the mirror binding, and spawns ONE **`pipeline-manager`** subagent (depth 1) that drives the whole chain in fresh-context `step-executor`s (depth 2), dispatching the improver/script-creator between steps. The supervisor keeps only what a subagent cannot do: a stable liveness pid, the hours-long nested-blocker poll-wait, and human-facing reporting; it acts on the manager's structured final report and can re-spawn the manager fresh on crash/overflow (the disk, not the manager, is the source of truth). Full original contract: `docs/execution-modes.md` § "Skill-layer architecture".
- `dispatch` contains real logic (matching ladder + chaining). It runs in the main session, not a subagent, because it needs to spawn subagents (the disambiguator, the executor) and hand off to `/pipeline:run` once per matched pipeline. It does NOT load all manifests into context except in the rare tier-3 chain-detection path; tier 1 happens in `pipeline match` and tier 2 happens inside the disambiguator subagent.
- Keep agent `tools` frontmatter tight: `pipeline-manager` **gets `Agent`** — it owns **chain-orchestration** spawning (a `step-executor` per step, plus `pipeline-improver` / `pipeline-script-creator`), running at depth 1 with depth-5 headroom; `step-executor` **gets `Agent` for INTRA-STEP FAN-OUT ONLY** — it is a leaf worker for the *chain* (runs one iteration and reports to the manager) and must never spawn a `pipeline-manager`/`step-executor` or advance the chain itself, but it MAY spawn a *synchronous, iteration-instructed* helper (e.g. a read-only `code-reviewer` at `03a`, or `Explore` searches) to do part of its own step's work — see the "Intra-step fan-out" section in `step-executor.md` for the load-bearing rules (only-when-instructed, synchronous, no re-entrancy, shallow tree, best-effort). It also gets `TaskUpdate` (to close/advance the harness tasks it opens — it already had `TaskCreate`/`TaskGet`/`TaskList`), plus `ToolSearch` + `LSP` (to load deferred MCP/browser tools and use language-server code intel when a step needs them); `pipeline-improver` does NOT get `Agent` either — it is a leaf, it edits files and emits a structured report (which may include a `script_creation_briefs` list for the caller to act on); `pipeline-script-creator` does NOT get `Agent` either — it writes one script, edits one iteration, reports; `pipeline-disambiguator` gets only `Read` and runs on Haiku (`model: haiku` — the alias, so it tracks the latest Haiku rather than pinning a version) — no Write/Edit/Bash, it is pure reasoning over inlined manifest content.

- **Token discipline at the skill layer.** `/pipeline:run` and `/pipeline:find` are pure routers — they MUST NOT read iteration files (`steps/**/*.md`) or `PIPELINE.md` content themselves. `/pipeline:design` reads only the pipeline material needed to author or revise a pipeline, following its on-demand authoring protocol. `/pipeline:dispatch` is also disciplined: tier 1 (the deterministic matcher) reads manifests inside `pipeline match`, tier 2 (the disambiguator) reads only the 2–5 ambiguous candidates' manifests inlined into a Haiku subagent's prompt, and only tier 3 (chain detection) loads all manifests into the main session — which fires on ~5% of calls.

- **`/pipeline:find` vs `/pipeline:dispatch`.** Both answer "task → pipeline?" — they differ in **ergonomics**, not in matcher technology. They share the same first-stage matcher (`pipeline match`, `<cli>/src/lib/match.ts`). `/pipeline:find` is the **inspection variant**: deterministic-only, single-pipeline, asks the user before running, accepts GitHub issue URLs via `--issue`, surfaces excluded-with-reason output. `/pipeline:dispatch` is the **autonomous variant**: same deterministic match in tier 1, falls back to a Haiku-based disambiguator (tier 2) when `pipeline match`'s top two scores are within 2× of each other, falls back to main-session chain detection (tier 3) when `pipeline match` returns 0 candidates AND the task contains chain phrasing. Dispatch auto-runs the chosen pipeline(s) without confirmation.

- **Script-step behavior is a lockstep chain.** Anything touching the `type: script` step contract — frontmatter / `## Params` parsing, in-process execution, records/actions, observability, or the docs — changes the whole chain together: `lib/plan.ts` ↔ `lib/script-types.ts` / `lib/script-step.ts` ↔ `lib/substitution.ts` / `lib/run-vars.ts` (whenever a change touches `command:`/`script:`/`## Params` `${PP_*}` semantics) ↔ `lib/next.ts` ↔ `commands/next.ts` ↔ `lib/step-schema.ts` ↔ `EVENTS.md` / `web/src/types.ts` / `logs.ts` / `stats.ts` ↔ the agent docs ↔ `README.md` / `docs/cli.md` / `docs/script-steps.md`. The frozen public contract is `docs/script-steps.md`; the full chain + rationale is in `roadmap/script-steps/DESIGN.md` §15.

- **Pipeline variables (`${PP_*}`)** parameterize a pipeline for different targets/environments without cloning it: an optional `## Variables` section in `PIPELINE.md` declares `PP_NAME (required)` / `PP_NAME (default: ...)` bullets (authoring guidance: `skills/design/references/authoring-protocol.md`); `pipeline next` / `drive` / `step run` accept repeatable `--var NAME=value` and `--vars-file <path>` to resolve them once at run init (CLI flag > environment > manifest default), validate fail-fast (aggregated, never first-error-only), and FREEZE the result for the whole run (a `--resume` reuses the frozen map verbatim; supplying new `--var`/`--vars-file` against a frozen run is a usage error). Values substitute into per-run rendered copies of agent iterations (`lib/render.ts`) and into script-step `command:`/`script:` argv + child env + `## Params` bindings (`lib/script-step.ts`, `docs/script-steps.md` §2.5) — non-secret by contract (D4): values are visible verbatim in rendered files, params files, child-script environments, logs, events, and AI context, so never design one to carry a secret. Full CLI-flag contract: `docs/cli.md`; full script-step argv/env contract incl. the argv[0]-substitution ban and the `.bat`/`.cmd` block: `docs/script-steps.md` §2.5.

## Pipeline folder contract (`pipeline.yml` + `steps/`)

This is a load-bearing invariant across the plugin — do not weaken it without
re-doing the token-cost analysis:

- **A step is NOT a file.** It is an entry in `pipeline.yml` identified by
  `name:`, unique within the pipeline. Nothing about a step comes from disk —
  not its identity, not its order, not its model, not its type. The engine
  resolves steps by NAME; a renamed body file does not re-identify a step, and
  two steps may share one body.
- Every pipeline folder has `pipeline.yml` at its root and a `steps/` subfolder
  holding the markdown its steps read. Body filenames carry no ordering prefix —
  order is the manifest's step list, plus `needs:`.
- `PIPELINE.md` is **optional prose for humans and is not parsed** where a
  manifest exists. Configuration put there does nothing. (A v1 pipeline with no
  manifest still parses it, and still runs; `computePlan` chooses between the
  two and never merges them.)
- Neither file is auto-loaded by `step-executor`. Step bodies remain
  self-contained; the executor loads the manifest only if a body's `Context`
  explicitly references it (opt-in, rare).
- The `/pipeline:run` skill takes a pipeline FOLDER. It reads nothing per step:
  the manifest decides where a run starts, so the common invocation passes no
  `--start` at all.
- A step's prompt may be COMPOSED from several markdown files (`body:` as a
  list, optionally conditional). The composed document is written into the run's
  shadow tree at `steps/<name>.md` — the step's own label, never a fragment it
  may share with other steps.
- The 300-token cap applied to the v1 `PIPELINE.md` manifest. It does not apply
  to `pipeline.yml`, which is configuration rather than prose the executor might
  load — but a manifest that has grown past a screenful is usually a pipeline
  that has grown past one job.

If you ever change the executor to auto-load the manifest, you are
re-introducing per-iteration token cost and breaking fresh-context
self-containment. Don't.

## Where a test lives (plugin-thin `p5`, updated by `p6`, settled by `p9`)

**A test lives in the tree that contains what it tests.** There are **three**
trees, and the boundary is no longer a plan — it is the repository boundary.
`apps/pipeline-cli` WAS a directory here; `p9` deleted it, and the CLI is now
`github.com/IvanMurzak/pipeline`. Nothing in this repository can reach CLI
source any more, which is what makes the rule self-enforcing: it used to need a
guard test (`cli-package-self-contained.test.ts`, removed with the directory)
to stop a CLI test reading a file above the CLI package.

| What the test touches | Where it lives | What runs it |
| --- | --- | --- |
| **CLI source or a hook relay's behaviour** | the CLI repository's `tests/` (written `<cli>/tests/…` here) | that repository's own CI, ubuntu + windows |
| `hooks/run-hook.sh` or `hooks/hooks.json` | **this repo's root `tests/`** | `cd tests && bun test`; CI job `plugin-hooks` |
| plugin prose/manifest **and** CLI source | the parent monorepo's `tests/cross-repo/` (written `<superrepo>/tests/cross-repo/` in code comments here) | its CI job `cross-repo` — the only tree with both on disk |

The first row merged two rows in `p9`. Until then "CLI source only" and "a hook
relay's behaviour" named two different homes because the relays had only just
moved; both are simply *the CLI repository* now. The five relays used to be
`.ts` files in this repository's `hooks/`, and their thirteen suites sat in the
root `tests/` beside them (`p5`). `p6` turned the relays into `pipeline hook
<name>` subcommands and twelve suites went with them; the thirteenth
(`hook-run-shim.test.ts`) covers the shim and the `hooks.json` wiring, which are
still this plugin's, and stayed. It is now the only test file here.

In code comments the two homes outside this repository are written `<cli>/…`
(the CLI's own repository, `github.com/IvanMurzak/pipeline`, published as
`@baizor/pipeline`) and `<superrepo>/tests/cross-repo/…` (the parent monorepo,
`IvanMurzak/ai-pipeline`, which carries both as submodules). `<plugin-root>/…`
still means this repository's root. All three stayed accurate across the
extraction, which a bare `tests/…` would not have.

⚠ **A positional argument to `bun test` is a file-NAME filter, not a
directory scope** — `bun test --help`: *"Run all test files with 'foo' or
'bar' in the file name."* So `bun test tests/` from the repo root matches
every path *containing* `tests/`. With the CLI gone there is little left here
to collide with, but the form is still wrong: scope by working directory
(`cd tests && bun test`), which is what CI does.

The third row is not a new invention: the parent monorepo's `drift` job already
checks out submodules for exactly this reason. A comparison test that needs two
repositories is vacuous inside either one of them.

`tests/cli-package-self-contained.test.ts` used to enforce the first row
mechanically, resolving **both** syntactic forms — `'../../../hooks/x.ts'` and
`resolve(import.meta.dir, '..', '..', '..', 'hooks')` — because a grep for the
first cannot see the second, and that blindness is exactly what let two files
slip past the sweep that commissioned this split. **It was removed in `p9`**,
on its own instruction: its first assertion failed with *"delete
`tests/cli-package-self-contained.test.ts` too"* once the directory was gone.
The rule it enforced is now enforced by the repository boundary instead — a
test in the CLI repository cannot reach a file in this one at all. Keep the
two-syntactic-forms lesson in mind anyway if you ever write another
path-escape guard.

## Testing the plugin

1. In a scratch directory (e.g. `C:/tmp/pipeline-test`), confirm CWD is the scratch dir.
2. Run `/pipeline:design Build a small CLI that lists top-level files sorted by size`.
3. Verify that `./.pipeline/<pipeline-name>/` is created in the scratch dir and contains:
   - `pipeline.yml` at the pipeline root, and `pipeline plan --root <dir>` reports zero errors.
   - A `steps/` subfolder holding one markdown per step, named after the step (no `NN-` prefix), each with all required sections and no dependency on the manifest.
4. Verify that **no files were created inside `${CLAUDE_PLUGIN_ROOT}`** — the plugin install directory must stay untouched.
5. Run `/pipeline:run <absolute-path>/.pipeline/<pipeline-name>`:
   - Confirm the skill shows a `▶ Starting pipeline <name>: <end state>` banner before delegation.
   - Confirm the executor does NOT read the manifest (check its tool-call log — only the current step's prompt should be loaded, plus whatever it explicitly references).
   - Confirm the chain runs to `Pipeline complete.` or halts with a clear blocker message.

## Reference docs (read on demand)

The deep contracts below were moved out of this file verbatim to keep every-session context lean. They are load-bearing — read the relevant doc BEFORE editing that subsystem, and keep its lockstep rules.

- The `pipeline` CLI — commands & contracts (`plan`/`match`/`event`/`route`/`next`/`logs`/`fix`/`submodule bump`; `pipeline next` is the orchestration state machine) — see `docs/cli.md`
- Execution modes, models & events — EVENTS schema v4, opt-in DAG/parallel, `isolation: external` + finalize, per-spawn model resolution + the shorthand map, the two-tier self-improvement loop, the nested-blocker loop, Agent-tool depth rules, and the full `/pipeline:run` supervisor architecture — see `docs/execution-modes.md`
- The event journal and its hooks — the hard invariants that outlived the deleted local dashboard (worktree resolution, run anchoring, bypass synthesis, liveness, the two opt-out switches, binding scope discipline) — see `docs/journal-and-hooks.md`, and the schema itself in `docs/events.md`
- Departments remote MCP entry + background notifier (department-mesh design, task a1) — the `plugin.json` `mcpServers` entry, the one-time OAuth connect flow, the notifier's poll/diff/journal architecture and its documented REST-vs-MCP transport deviation, OS-notify + SessionStart-context dual delivery, env vars — see `docs/departments-mcp.md`
- Telemetry, privacy and the cloud, for USERS — the launch surfaces and their reporting granularity (`docs/running-pipelines.md`), the metadata-tier allowlist field for field (`docs/privacy-tiers.md`), and connect/history-upload/retention/deletion/offline behaviour (`docs/cloud-connect.md`). `privacy-tiers.md` is transcribed from `src/lib/vendor/privacy.ts` in the `pipeline` CLI repository — **change it in lockstep with that file**, and never from a design document.
- Nested-blocker delegation — `blocker_delegation` brief fields + the supervisor orchestration flow — see `docs/nested-blocker-delegation.md`
- External-isolation worktree hooks — the FROZEN `PIPELINE_WT_*` env-var + JSON consumer contract — see `docs/worktree-hook-contract.md`
- Script steps (`type: script`) — the FROZEN process I/O contract for zero-token deterministic steps: frontmatter, `## Params`/`## Output` + `${…}` bindings, `PIPELINE_STEP_*` env vars + the stdout result object, failure classes + `on-failure`/`retries`, the attempt ledger, the outputs store, and `pipeline step run` — see `docs/script-steps.md`
- Source of the design (provenance) — see `docs/history.md`
