/**
 * hooks/run-hook.sh — the POSIX-sh binary-resolution shim every
 * hooks/hooks.json command routes through.
 *
 * WHY THIS EXISTS: Claude Code runs plugin hooks through non-interactive
 * /bin/sh, which does not source ~/.zshrc. On macOS a global install lands in
 * ~/.bun/bin, and PATH only gains that entry from the interactive shell rc —
 * so a bare `pipeline hook <name>` hook command fails with "pipeline: command
 * not found" whenever Claude Code is launched from the Dock/Finder rather
 * than a terminal. run-hook.sh resolves the binary's absolute path itself
 * (PATH → $BUN_INSTALL/bin → ~/.bun/bin → /opt/homebrew/bin → /usr/local/bin)
 * and `exec`s into it, so it must be exercised as a REAL shell script (not
 * imported as TS) — this file drives it with `sh`, a stubbed PATH/HOME/
 * BUN_INSTALL, and fake `pipeline` binaries planted at each candidate
 * location.
 *
 * WHAT CHANGED IN plugin-thin `p6`, AND WHAT DID NOT. The shim used to
 * resolve `bun`, because the five relays were `.ts` scripts in this
 * repository's `hooks/` directory and ran as `bun <relay>.ts`. They are now
 * subcommands of the CLI (`pipeline hook <name>`, in `IvanMurzak/pipeline`),
 * so the shim resolves `pipeline` instead. NOTHING ELSE about it changed:
 * same probe order, same `exec` passthrough, same `--loud` contract, same
 * committed mode. The bug it prevents was never about which binary sat at the
 * end of the chain.
 *
 * Coverage:
 *   - each of the 3 env-controllable candidates (PATH, $BUN_INSTALL/bin,
 *     ~/.bun/bin) resolves to ITS OWN stub, proving the lookup chain reaches
 *     each rung (candidates 4/5 are fixed absolute Homebrew paths that
 *     cannot be safely exercised by planting files at real system locations
 *     from a test — covered instead by the source-text check below and by
 *     the fact the "not found" tests prove nothing earlier in the chain
 *     false-positives on this machine).
 *   - resolution ORDER: PATH beats $BUN_INSTALL beats ~/.bun/bin.
 *   - stdin, argv, and exit code all pass through `exec` untouched (Claude
 *     Code feeds hook JSON on stdin and reads the relay's own stdout/exit
 *     code — the shim must never buffer or rewrite them).
 *   - pipeline-not-found: quiet mode (every hook except the primary
 *     SessionStart entry) exits 0 with NO output; --loud mode (SessionStart
 *     only) exits 0 with exactly ONE actionable stderr line that NAMES THE
 *     INSTALL COMMAND. After `p6` this plugin ships no code of its own, so
 *     that line is the entire safety net for a user who has not installed
 *     the CLI — "not found" alone would not be actionable.
 *   - pipeline PRESENT BUT TOO OLD (the plugin-thin release blocker): a CLI
 *     with no `hook` subcommand answers `unknown command 'hook'` with exit 2,
 *     and a non-zero PreToolUse exit BLOCKS THE TOOL CALL. The shim must turn
 *     that into exit 0 — while STILL PROPAGATING a genuine non-zero from a
 *     CLI that does have the subcommand, because a PreToolUse deny is a
 *     correct non-zero exit and swallowing it would disable a safety control.
 *     Both directions are asserted below with two different fake CLIs; a
 *     blanket `exit 0` fails the second one.
 *   - pipeline PRESENT, HAS `hook`, BUT BELOW MIN_CLI_VERSION (plugin-thin
 *     B.2, the case the mechanism above cannot see: `hook --help` succeeds,
 *     so it never gets classified as "no hook subcommand"). Only once the
 *     primary `hook` call already succeeded: older prints exactly one upgrade
 *     line to STDERR (never stdout — that channel is asserted directly, since
 *     a SessionStart hook's stdout becomes additionalContext, not a
 *     guaranteed user-facing banner); equal and newer are silent; a
 *     `--version` output that doesn't parse as this CLI's real shape (bare
 *     `N.N.N`) is UNKNOWN — reported once, never treated as "too old". A
 *     dedicated test proves the two old-CLI mechanisms are disjoint: a CLI
 *     with no `hook` at all never reaches the version check, even though it
 *     would also fail `--version`.
 *   - `w4`, THE DELIVERY CHANNEL. Every warning above used to end in
 *     `exit 0`, and Claude Code routes a zero-exit hook's stderr to the debug
 *     log ONLY — so none of the three had ever reached a user or Claude. They
 *     now exit 1, which is a NON-BLOCKING error on every event and which the
 *     transcript surfaces as `hook_non_blocking_error`. The exit codes are
 *     asserted here in both directions: 1 where a line was printed, and
 *     explicitly NOT 2, because 2 is the blocking status and a version
 *     problem may never block a tool call.
 *   - `w4`, THE ONCE-PER-SESSION MARKER (T-CLI-3). The MIN_CLI_VERSION check
 *     is no longer gated on `--loud`; it runs on every invocation, because
 *     `/reload-plugins` activates a raised floor mid-session and does NOT
 *     re-fire SessionStart. A marker file keyed on the floor, the plugin
 *     root, the resolved binary and a session-stable id keeps that
 *     affordable: 20 invocations cost ONE `--version` spawn and produce ONE
 *     line, a raised floor in the same session re-fires, and a relay's exit 2
 *     still propagates untouched through all of it.
 *   - hooks/hooks.json wiring: every one of the 10 hook commands routes
 *     through the shim and invokes `hook <name>` for one of the five real
 *     relays (no bare `bun ` and no `.ts` path survives), and --loud appears
 *     on exactly one of the two SessionStart entries (two loud entries would
 *     print the warning twice per session).
 *   - the committed file mode is 100755 — a non-executable shim reintroduces
 *     the exact bug this fixes on a fresh clone.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(PLUGIN_ROOT, 'hooks', 'run-hook.sh');
const SH = typeof Bun !== 'undefined' ? Bun.which('sh') : null;

// ---------------------------------------------------------------------------
// canary: every `describe.skipIf(!SH)` block below (the overwhelming
// majority of this file's coverage) silently SKIPS, not fails, when `sh`
// does not resolve — and this file's own README-style header documents that
// as an intentional self-skip for a `sh`-less environment. That is correct
// for a genuinely POSIX-sh-less machine, but wrong for the windows-latest CI
// job specifically: that job is EXPECTED to have Git Bash's `sh` on PATH
// (that's the whole point of running this suite there), so a future runner-
// image change that quietly drops it from PATH would turn 28 of this file's
// 34 tests into skips while the job stays green — exactly the failure shape
// this task's own Fact-1 side-finding proved is real on a Windows machine
// with a minimal PATH (26/30 skipped from a bare, non-Git-Bash PowerShell
// process on this dev machine). This canary is unconditional (not
// `skipIf`-gated) and scoped to `win32` + `CI` only, so it cannot fire on a
// contributor's local sh-less machine or on the ubuntu job — only on the
// runner this file's coverage actually depends on.
// ---------------------------------------------------------------------------

test('CI canary (win32 only): `sh` must resolve on the Windows CI runner, or the SH-gated suite above silently skips green instead of running', () => {
  if (process.platform !== 'win32' || !process.env.CI) return;
  expect(
    SH,
    'Bun.which("sh") returned null on a Windows CI runner: every describe.skipIf(!SH) block in this file just SKIPPED instead of running (28 of 34 tests). Fix the runner image/PATH (needs Git\\bin or Git\\usr\\bin reachable), not this test.'
  ).not.toBeNull();
});

/** The subcommand names hooks.json is allowed to invoke. Restated here rather
 *  than imported: the CLI that implements them is a different repository and
 *  is not on disk in this checkout — which is exactly why the two-sided parity
 *  check (these names EXIST in the CLI) lives in the parent monorepo's
 *  `tests/cross-repo/` suite instead. What this file can prove alone is that
 *  hooks.json invokes the shim, in the `hook <name>` shape, for names from a
 *  closed set. */
const RELAYS = [
  'analytics-relay',
  'stats-relay',
  'session-relay',
  'department-notifier-relay',
  'prompt-match-relay',
];

/** The floor the shim declares, read back out of the script itself.
 *  MIN_CLI_VERSION is the SINGLE SOURCE OF TRUTH for that number — no test
 *  may restate it, or there would be two declarations, which is the exact
 *  failure the comment above it in run-hook.sh exists to prevent. */
const MIN_CLI_VERSION: string = (() => {
  const m = /^MIN_CLI_VERSION="([0-9.]+)"$/m.exec(readFileSync(SCRIPT, 'utf-8'));
  if (!m) throw new Error('could not read MIN_CLI_VERSION out of run-hook.sh');
  return m[1]!;
})();

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    const dir = created.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort, but surfaced rather than swallowed: some of these dirs
      // carry a ~100MB copied `pipeline.exe` (the real-.exe tests below), and
      // a silently-swallowed failure here (e.g. an AV hold, EBUSY on
      // Windows) leaks that copy in %TEMP% instead of just failing loudly.
      // Disk litter only, never a test failure — never affects PATH.
      console.warn(`hook-run-shim.test.ts: afterAll cleanup failed to remove ${dir}:`, err);
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Plants a fake `pipeline` at <dir>/pipeline that reports its own label,
 *  echoes argv and stdin back on stdout (so passthrough is provable), and
 *  exits with the given code. Reads stdin with the `read` SHELL BUILTIN (not
 *  `cat`) — the tests deliberately restrict PATH to just this stub's own
 *  directory to pin candidate resolution, so an external `cat` would be
 *  unresolvable and falsely look like a stdin-passthrough failure. */
function mkStubPipeline(dir: string, label: string, exitCode = 0): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = [
    '#!/bin/sh',
    // Answers `--version` with the CURRENT floor, and answers it FIRST. Since
    // `w4` the shim runs its MIN_CLI_VERSION check on every invocation whose
    // relay succeeded, not only under `--loud` — so a stub that echoed its
    // argv here would be read as an unparseable version string and every
    // resolution-chain test below would fail on a warning it is not about.
    `if [ "$1" = "--version" ]; then printf '${MIN_CLI_VERSION}\\n'; exit 0; fi`,
    `printf 'STUB=${label} ARGS=%s\\n' "$*"`,
    'IFS= read -r line',
    "printf 'STDIN=%s\\n' \"$line\"",
    `exit ${exitCode}`,
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Runs run-hook.sh under `sh` with a FULLY explicit env (never inherits the
 *  real PATH/HOME — this test's whole point is controlling candidate
 *  resolution precisely). */
function run(args: string[], env: Record<string, string>, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  // Every call gets its OWN TMPDIR unless the caller pinned one deliberately.
  // Since `w4` the shim drops a once-per-session marker file in the system
  // temporary directory, and that marker SUPPRESSES the version check for the
  // rest of the "session". Sharing one real temp dir across this file would
  // therefore let the first test that runs silence every later one — a
  // green-because-skipped suite, which is the failure mode this file's own CI
  // canary exists to prevent elsewhere. Tests that need two invocations to
  // share a session pass TMPDIR themselves.
  const fullEnv = { ...env, TMPDIR: env.TMPDIR ?? mkTmp('shim-tmpdir-') };
  const r = spawnSync(SH!, [SCRIPT, ...args], { env: fullEnv, input: stdin, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Same as `run`, but drives an ARBITRARY script path — used to simulate a
 *  `/reload-plugins` that swapped this shim for a copy carrying a different
 *  MIN_CLI_VERSION, which is the T-CLI-3 case. */
function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  stdin = '',
): { status: number | null; stdout: string; stderr: string } {
  const fullEnv = { ...env, TMPDIR: env.TMPDIR ?? mkTmp('shim-tmpdir-') };
  const r = spawnSync(SH!, [script, ...args], { env: fullEnv, input: stdin, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Writes run-hook.sh to `path` with MIN_CLI_VERSION rewritten to `floor`.
 *  This is exactly what a plugin upgrade ships — the floor is a literal in
 *  the shim — so rewriting it and re-running in the SAME session and the SAME
 *  temp dir simulates `/reload-plugins` picking up a plugin that raised it.
 *
 *  THE PATH IS A PARAMETER SO THE CALLER CAN KEEP IT FIXED, and that matters
 *  more than it looks: `$0` is itself a component of the marker key, so a
 *  "reloaded" copy written to a NEW directory would re-fire the check even if
 *  floor-keying were completely broken. A test that moves the script proves
 *  only that *something* in the key changed, and would stay green while
 *  T-CLI-3 — this task's headline feature — silently regressed. Rewriting in
 *  place at one path holds `$0` constant so the floor is the only variable. */
function writeShimWithFloor(path: string, floor: string): void {
  const src = readFileSync(SCRIPT, 'utf-8');
  const assignment = /^MIN_CLI_VERSION="[0-9.]+"$/m;
  // Assert the PATTERN MATCHED, not that the text changed. Writing the floor
  // the shim already declares is a legitimate call — the T-CLI-3 test opens
  // with exactly that to establish its baseline — so a `rewritten === src`
  // check would reject a correct no-op rewrite while still missing nothing.
  if (!assignment.test(src)) throw new Error('MIN_CLI_VERSION assignment not found in run-hook.sh — the rewrite would have silently done nothing');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, src.replace(assignment, `MIN_CLI_VERSION="${floor}"`));
  chmodSync(path, 0o755);
}

/** The shim's own warning lines, isolated from anything a stub CLI printed. */
function ourLines(stderr: string): string[] {
  return stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
}

// ---------------------------------------------------------------------------
// resolution chain — each env-controllable candidate, plus ordering
// ---------------------------------------------------------------------------

describe.skipIf(!SH)('run-hook.sh resolution chain (sh: ' + (SH ?? 'unavailable — suite skipped') + ')', () => {
  test('candidate 1 (PATH): resolved via `command -v pipeline`; argv + stdin + exit code pass through exec untouched', () => {
    const dir = mkTmp('shim-path-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH', 7);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') }, 'hook-json-on-stdin');
    expect(r.status).toBe(7); // exit code from the resolved binary, not swallowed
    expect(r.stdout).toContain('STUB=PATH');
    expect(r.stdout).toContain('ARGS=hook analytics-relay');
    expect(r.stdout).toContain('STDIN=hook-json-on-stdin');
  }, 15000);

  test('candidate 2 ($BUN_INSTALL/bin): used when PATH has no pipeline', () => {
    const dir = mkTmp('shim-businstall-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  test('candidate 3 (~/.bun/bin): used when PATH and $BUN_INSTALL have no pipeline (default install location)', () => {
    const dir = mkTmp('shim-home-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, HOME: home }); // BUN_INSTALL intentionally absent
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=HOME');
  }, 15000);

  test('order: PATH wins over $BUN_INSTALL and ~/.bun/bin when all three exist', () => {
    const dir = mkTmp('shim-order-a-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH');
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: pathDir, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=PATH');
  }, 15000);

  test('order: $BUN_INSTALL wins over ~/.bun/bin when PATH has no pipeline', () => {
    const dir = mkTmp('shim-order-b-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubPipeline(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubPipeline(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['hook', 'session-relay'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  test('the probe order in the source still lists all five candidates, in order', () => {
    // Candidates 4 and 5 are absolute system paths a test may not plant files
    // at. Their presence — and the ORDER of the whole chain — is read off the
    // script text instead, so a reordering or a dropped rung fails here even
    // though the last two rungs cannot be executed.
    const src = readFileSync(SCRIPT, 'utf-8');
    const order = [
      'command -v pipeline',
      '"$BUN_INSTALL/bin/pipeline"',
      '"$HOME/.bun/bin/pipeline"',
      '/opt/homebrew/bin/pipeline',
      '/usr/local/bin/pipeline',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = src.indexOf(needle, cursor + 1);
      expect(at, `probe candidate missing or out of order: ${needle}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  // ---------------------------------------------------------------------------
  // pipeline nowhere to be found
  // ---------------------------------------------------------------------------

  test('pipeline not found, no --loud (quiet — used by every hook except the primary SessionStart entry): exits 0 with ZERO output', () => {
    const dir = mkTmp('shim-notfound-quiet-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['hook', 'analytics-relay'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0); // never fails the (non-blocking) hook
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 15000);

  test('pipeline not found, --loud (SessionStart primary entry only): exits 1 — the DELIVERY channel — with exactly ONE line that names the install command', () => {
    const dir = mkTmp('shim-notfound-loud-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: emptyPath, HOME: home });
    // 1, NOT 0 (`w4`). This line spent its whole existence going to the debug
    // log and nowhere else, because Claude Code discards a zero-exit hook's
    // stderr. Exit 1 turns it into a `hook_non_blocking_error` the transcript
    // actually shows, and 1 is non-blocking on every event — measured against
    // Claude Code 2.1.236, including a PreToolUse whose tool call still ran.
    // It must never become 2: 2 is the blocking status.
    expect(r.status).toBe(1);
    // Nothing on stdout: an empty stdout is what keeps the transcript
    // classification at `hook_non_blocking_error`. Schema-valid hook JSON
    // there would make Claude Code ignore the exit code and re-classify the
    // whole thing as a success, silencing the line again.
    expect(r.stdout).toBe('');
    const lines = r.stderr.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('pipeline');
    // ACTIONABLE, not merely descriptive: the exact package to install, the
    // command that installs it, and the escape hatch for a non-standard
    // location. This plugin cannot work without the CLI after plugin-thin
    // `p6`, so this one line is the whole recovery path.
    expect(lines[0]).toContain('@baizor/pipeline');
    expect(lines[0]).toContain('add -g');
    expect(lines[0]).toContain('BUN_INSTALL');
  }, 15000);

  test('missing arguments (malformed hooks.json entry) degrades to a silent no-op, never crashes', () => {
    const dir = mkTmp('shim-noargs-');
    const pathDir = join(dir, 'pathdir');
    mkStubPipeline(pathDir, 'PATH');
    const r = run([], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // the stub was never invoked
  }, 15000);
});

// ---------------------------------------------------------------------------
// T-CLI-2 / plugin-thin `v1`: the happy path with a REAL Windows .exe, not a
// POSIX-shebang stub.
//
// Every stub above (`mkStubPipeline` et al.) plants a plain `#!/bin/sh`
// script named `pipeline` with NO extension. That proves the probe ORDER,
// but on Windows it does not exercise the one platform-specific claim this
// shim's own header comment makes and that plugin-thin `p6` said was
// "verified, not assumed": that the MSYS `sh` Claude Code spawns for hooks
// resolves a bare `pipeline` (typed with no extension, exactly as
// `command -v pipeline` and `run-hook.sh`'s own candidates do) to the REAL
// `pipeline.exe` that `bun add -g` / `npm i -g` actually place on disk —
// because an extensionless POSIX-shebang script happens to run the same way
// on every platform and so never touches Windows' PE-vs-extensionless-name
// resolution at all. This block closes that gap with a genuine compiled
// Windows executable (the `bun.exe` already on PATH for this very test run —
// no network fetch, nothing installed) renamed to `pipeline.exe`, placed at
// candidates 1 and 3 of the real probe order. Windows-only: the claim being
// tested does not exist on macOS/Linux.
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32' || !SH)('run-hook.sh resolves a REAL .exe, not just a POSIX-shebang script (T-CLI-2 happy path)', () => {
  test('candidate 1 (PATH): `pipeline` typed with no extension resolves to a real pipeline.exe PE binary', () => {
    const bunPath = Bun.which('bun');
    if (!bunPath) throw new Error('bun not resolvable on PATH — no real .exe available to source for this test');
    const dir = mkTmp('shim-real-exe-path-');
    const pathDir = join(dir, 'pathdir');
    mkdirSync(pathDir, { recursive: true });
    copyFileSync(bunPath, join(pathDir, 'pipeline.exe'));
    // Non-`hook` shape: run-hook.sh `exec`s straight through to the resolved
    // binary, so a real, successful, non-127 exit proves candidate 1 found
    // and ran the `.exe` despite the extensionless argv/PATH lookup.
    const r = run(['--version'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).not.toBe(127); // 127 is `sh`'s own "command not found"
    expect(r.stderr).not.toContain('not found');
    expect(r.stdout.trim().length).toBeGreaterThan(0); // the real binary answered `--version`
  }, 15000);

  test('candidate 3 (~/.bun/bin): the same real .exe, at the actual default bun global-install location', () => {
    const bunPath = Bun.which('bun');
    if (!bunPath) throw new Error('bun not resolvable on PATH — no real .exe available to source for this test');
    const dir = mkTmp('shim-real-exe-home-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home');
    const bunBin = join(home, '.bun', 'bin');
    mkdirSync(bunBin, { recursive: true });
    copyFileSync(bunPath, join(bunBin, 'pipeline.exe'));
    const r = run(['--version'], { PATH: emptyPath, HOME: home }); // BUN_INSTALL intentionally absent
    expect(r.status).not.toBe(127);
    expect(r.stderr).not.toContain('not found');
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// version skew: the CLI is installed, but predates `pipeline hook <name>`
//
// THE RELEASE BLOCKER, in one sentence: after plugin-thin `p6` hooks.json
// invokes `pipeline hook <name>`, so a user whose PLUGIN updates while their
// globally installed CLI does not gets `unknown command 'hook'` → exit 2 → a
// BLOCKED TOOL CALL on nearly every turn. The shim is the only part of the
// chain that runs before the CLI, so the mitigation lives there.
//
// The hard part is not exiting 0 — it is exiting 0 for THIS reason only. A
// real PreToolUse deny is also a non-zero exit and is CORRECT; swallowing it
// would silently disable a safety control. The shim therefore asks the CLI a
// second, read-only question after a failure (`pipeline hook --help`, which
// succeeds on a CLI that has the subcommand and is refused by one that does
// not) instead of guessing from the exit code. Both fakes below answer that
// probe the way the real CLIs do — the old one from the pre-extraction
// embedded CLI's `unknown command '${command}'` default branch (that copy
// lived at `apps/pipeline-cli/` and was REMOVED in plugin-thin `p9`; the fake
// stays because a user can still have that vintage installed), the new one
// from `IvanMurzak/pipeline`'s `runHook`, whose `--help` prints usage on
// stdout and returns 0.
// ---------------------------------------------------------------------------

/** A fake OLD `pipeline`: no `hook` subcommand at all, so every invocation —
 *  the relay call AND the shim's capability probe — is refused at the top
 *  level with the CLI's real message and exit 2. Appends each argv to `log`
 *  so the test can prove the probe never re-ran the relay. */
function mkStubOldCli(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
    `printf "pipeline: unknown command '%s'\\n" "$1" >&2`,
    "printf 'OLD-CLI-USAGE\\n' >&2",
    'exit 2',
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** A fake NEW `pipeline`: knows `hook`, so `hook --help` prints usage on
 *  stdout and exits 0. Its relay exits with `relayExit` — 2 models a genuine
 *  PreToolUse deny, which MUST still reach Claude Code. */
function mkStubNewCli(dir: string, log: string, relayExit: number): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
    // A CURRENT version, so this stub models "new CLI" on the axis this block
    // is about (does it know `hook`?) without also tripping the independent
    // MIN_CLI_VERSION check, which since `w4` runs after every successful
    // relay call rather than only under `--loud`.
    `if [ "$1" = "--version" ]; then printf '${MIN_CLI_VERSION}\\n'; exit 0; fi`,
    'if [ "$1" = "hook" ] && [ "$2" = "--help" ]; then',
    "  printf 'pipeline hook <name>\\n'",
    '  exit 0',
    'fi',
    "printf 'DENY: edit is out of scope for this run\\n' >&2",
    `exit ${relayExit}`,
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

function readLog(log: string): string[] {
  try {
    return readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe.skipIf(!SH)('run-hook.sh vs. an out-of-date CLI (plugin-thin release blocker)', () => {
  test('OLD CLI, quiet: `unknown command \'hook\'` + exit 2 becomes exit 0 — the tool call is NOT blocked', () => {
    const dir = mkTmp('shim-oldcli-quiet-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') }, '{"hook_event_name":"PreToolUse"}');
    expect(r.status).toBe(0); // was 2 before the fix: a blocked tool call on every turn
    // Quiet mode adds NOTHING of its own. The old CLI's own refusal still
    // passes through verbatim (suppressing it would mean capturing the real
    // run's stderr, which is exactly the buffering this shim may not do) —
    // but exactly ONCE: the probe's copy is captured, not leaked.
    expect(r.stderr.split('OLD-CLI-USAGE').length - 1).toBe(1);
    expect(r.stderr).not.toContain('@baizor/pipeline');
    // Nothing may reach stdout — Claude Code parses hook stdout as JSON, so a
    // leaked `hook --help` from the probe would corrupt it.
    expect(r.stdout).toBe('');
  }, 15000);

  test('OLD CLI, --loud (SessionStart): exit 1 — never the relay\'s own 2 — plus exactly ONE line naming the upgrade command', () => {
    const dir = mkTmp('shim-oldcli-loud-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    // The two halves of this assertion pull in opposite directions and both
    // matter. 1, because on exit 0 the line below reached nobody (`w4`).
    // NOT 2, because the old CLI exited 2 and propagating that is the blocked
    // tool call on every turn that this whole branch exists to defuse — the
    // plugin-thin release blocker. 1 is the only status that is both audible
    // and non-blocking.
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    const ours = ourLines(r.stderr);
    expect(ours.length).toBe(1); // one line, not a flood
    expect(ours[0]).toContain('too old');
    // ACTIONABLE: the exact package and both install paths a user may have
    // used, exactly as the not-found line does.
    expect(ours[0]).toContain('@baizor/pipeline');
    expect(ours[0]).toContain('bun add -g');
    expect(ours[0]).toContain('npm i -g');
  }, 15000);

  test('the capability probe is read-only: it re-runs `hook --help`, NEVER the relay (no duplicate journal writes)', () => {
    const dir = mkTmp('shim-oldcli-probe-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['hook', 'stats-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(readLog(log)).toEqual(['hook stats-relay', 'hook --help']);
  }, 15000);

  // ── the other direction: what must STILL fail ────────────────────────────

  test('NEW CLI, genuine deny: a non-zero exit from a CLI that HAS `hook` still propagates (a blanket `exit 0` fails here)', () => {
    const dir = mkTmp('shim-newcli-deny-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 2); // 2 = PreToolUse deny — the tool call MUST be blocked
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('DENY: edit is out of scope for this run');
    expect(r.stderr).not.toContain('pipeline plugin:'); // not a version-skew warning
    // Deliberately asserts nothing about HOW the shim decided: this is the
    // invariant that must hold before this fix and after it, and it is the
    // test a blanket `exit 0` — or any future "just don't block" shortcut —
    // turns red on. The probe mechanics are pinned separately below.
  }, 15000);

  test('NEW CLI, genuine deny, --loud: still propagates — the loud/quiet flag governs the MESSAGE, never the status', () => {
    const dir = mkTmp('shim-newcli-deny-loud-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 2);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('pipeline plugin:');
  }, 15000);

  test('NEW CLI, arbitrary failure code: propagated verbatim, not normalised', () => {
    const dir = mkTmp('shim-newcli-fail-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 9);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(9);
    // The probe DID run (the failure had to be classified) and its answer —
    // `hook --help` exits 0, so this CLI has the subcommand — was honoured.
    expect(readLog(log)).toEqual(['hook analytics-relay', 'hook --help']);
  }, 15000);

  test('success costs nothing: a relay that exits 0 is never PROBED — the only extra spawn is the once-per-session version read', () => {
    const dir = mkTmp('shim-newcli-ok-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 0);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    // `hook --help` — the capability probe — still never runs after a
    // SUCCESSFUL relay call, which is the invariant this test has always
    // pinned. What is new in `w4` is the `--version` read, and it appears
    // here only because `run()` hands every call a fresh TMPDIR, i.e. a fresh
    // session. The repeated-invocation test below proves it does NOT recur.
    expect(readLog(log)).toEqual(['hook analytics-relay', '--version']);
    expect(readLog(log)).not.toContain('hook --help');
  }, 15000);

  test('non-`hook` invocations are untouched: an old CLI refusing `plan` still exits 2', () => {
    // The blanket-exit-0 blast radius is deliberately confined to the one
    // subcommand that is on the "must never block the session" contract. A
    // skill shelling through the shim wants its failure to surface.
    const dir = mkTmp('shim-oldcli-nonhook-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['plan', '--json'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(2);
    expect(readLog(log)).toEqual(['plan --json']); // exec'd, never probed
  }, 15000);
});

// ---------------------------------------------------------------------------
// minimum CLI version: hook-capable but still too old (plugin-thin B.2)
//
// THE GENUINELY UNCOVERED CASE, in one sentence: a CLI that DOES answer
// `hook` (so the mechanism above never fires — `hook --help` succeeds) can
// still be older than what this plugin's skills/agents assume. run-hook.sh
// declares MIN_CLI_VERSION and compares `pipeline --version` against it, but
// ONLY on the --loud SessionStart entry, and ONLY once the primary `hook`
// call has already succeeded — which structurally keeps this mechanism
// disjoint from the no-hook-subcommand one above (proven directly below,
// not just argued: a CLI that refuses everything, `--version` included,
// still prints exactly one line, not two).
//
// CHANNEL: every line here lands on STDERR, matching the not-installed and
// no-hook-subcommand lines. stdout is asserted empty in the headline case —
// Claude Code parses a hook's stdout, and a SessionStart hook's stdout is
// what becomes additionalContext, so nothing here may leak into it.
// ---------------------------------------------------------------------------

/** A fake CLI that HAS `hook` — both `hook --help` and any `hook <name>`
 *  relay call succeed — and reports a configurable, arbitrary `--version`
 *  string. This is the shape the mechanism above can never classify (its
 *  probe would also succeed), which is exactly the gap this stub exercises:
 *  MIN_CLI_VERSION comparison, not hook-subcommand presence. */
function mkStubVersionedCli(dir: string, log: string, versionOutput: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline');
  const escaped = versionOutput.replace(/'/g, `'\\''`);
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${escaped}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "hook" ] && [ "$2" = "--help" ]; then',
    "  printf 'pipeline hook <name>\\n'",
    '  exit 0',
    'fi',
    "printf 'RELAY-OK\\n'",
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

describe.skipIf(!SH)('run-hook.sh minimum CLI version (B.2: hook-capable but too old)', () => {
  test('older than MIN_CLI_VERSION, --loud: exactly ONE line, on STDERR (not stdout-to-context), naming the upgrade command, and exit 1 so it is delivered', () => {
    const dir = mkTmp('shim-minver-older-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '0.1.0'); // below any real MIN_CLI_VERSION
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(1); // audible (w4) — and never 2, which would block
    expect(r.stdout).not.toContain('pipeline plugin:'); // the channel: NOT stdout-to-context
    const lines = ourLines(r.stderr);
    expect(lines.length).toBe(1); // exactly one line
    expect(lines[0]).toContain('older');
    expect(lines[0]).toContain('0.1.0');
    expect(lines[0]).toContain('@baizor/pipeline');
    expect(lines[0]).toContain('bun add -g');
  }, 15000);

  test('older than MIN_CLI_VERSION, QUIET: now checks and warns too — the --loud gate on this check is what made T-CLI-3 unfixable', () => {
    // BEHAVIOUR DELIBERATELY CHANGED IN `w4`. This test used to assert the
    // exact opposite ("silent, and --version is never even spawned"), and the
    // inversion is the point of the task rather than a regression: the check
    // was reachable only from the `--loud` SessionStart entry, so only a
    // RESTART could ever re-fire it. `/reload-plugins` activates a plugin
    // upgrade mid-session WITHOUT a restart and WITHOUT re-firing
    // SessionStart, so a reloaded plugin carrying a raised floor was never
    // re-checked. Quiet hooks are the only ones that fire in that window.
    //
    // The flood this gate used to prevent is now prevented by the marker file
    // instead — see the `once per session` block below, which pins 20
    // invocations to a single spawn and a single line.
    const dir = mkTmp('shim-minver-older-quiet-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('RELAY-OK\n'); // the relay's own stdout, untouched
    const lines = ourLines(r.stderr);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('older');
    expect(readLog(log)).toEqual(['hook analytics-relay', '--version']);
  }, 15000);

  test('equal to MIN_CLI_VERSION, --loud: silence (current, not "too old")', () => {
    const dir = mkTmp('shim-minver-equal-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, MIN_CLI_VERSION);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('RELAY-OK\n');
    expect(r.stderr).toBe('');
  }, 15000);

  test('newer than MIN_CLI_VERSION, --loud: silence', () => {
    const dir = mkTmp('shim-minver-newer-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '99.0.0');
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  }, 15000);

  test('malformed --version output, --loud: treated as unknown — not "too old", not silently ignored, reported exactly once', () => {
    const dir = mkTmp('shim-minver-malformed-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, 'not-a-version');
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(1); // delivered (w4), and never 2 — unknown must not BLOCK
    const lines = ourLines(r.stderr);
    expect(lines.length).toBe(1); // said once, not silently swallowed
    expect(lines[0]).not.toContain('is older'); // not a false "too old" accusation
    expect(lines[0]).toContain('could not read');
  }, 15000);

  test('a CLI with `hook` but NO `--version` support at all: also treated as unknown, not "too old"', () => {
    // A degenerate but real-world-plausible shape: the probe and the relay
    // both succeed, but --version itself is an unrecognised subcommand.
    const dir = mkTmp('shim-minver-noversion-');
    const pathDir = join(dir, 'pathdir');
    const p = join(pathDir, 'pipeline');
    mkdirSync(pathDir, { recursive: true });
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "hook" ] && [ "$2" = "--help" ]; then',
      "  printf 'pipeline hook <name>\\n'",
      '  exit 0',
      'fi',
      'if [ "$1" = "hook" ]; then',
      "  printf 'RELAY-OK\\n'",
      '  exit 0',
      'fi',
      "printf \"pipeline: unknown command '%s'\\n\" \"$1\" >&2",
      'exit 2',
      '',
    ].join('\n');
    writeFileSync(p, script);
    chmodSync(p, 0o755);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(1);
    const lines = ourLines(r.stderr);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('could not read');
  }, 15000);

  test('the two old-CLI mechanisms are mutually exclusive: a CLI with NO hook subcommand at all never reaches the version check, even though it would also fail --version', () => {
    // mkStubOldCli refuses EVERY subcommand, including --version — so if the
    // ordering guard in run-hook.sh ever regressed (running the version
    // check before, or independent of, the hook success branch), this would
    // start printing TWO "pipeline plugin:" lines instead of one, which would
    // also break the pinned "OLD CLI, --loud" test above. Re-asserted here
    // from the version-check side for the same invariant.
    const dir = mkTmp('shim-minver-disjoint-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(1);
    const lines = ourLines(r.stderr);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('too old');
    expect(lines[0]).not.toContain('could not read');
    expect(lines[0]).not.toContain('is older than this plugin needs');
    expect(readLog(log).some((l) => l.startsWith('--version'))).toBe(false); // never spawned
  }, 15000);
});

// ---------------------------------------------------------------------------
// w4: the once-per-session marker — T-CLI-3, the spawn budget, and the flood
//
// The check above now runs on EVERY hook invocation instead of only the
// `--loud` SessionStart entry, because SessionStart is exactly what
// `/reload-plugins` does NOT re-fire, and a mid-session plugin upgrade
// carrying a RAISED floor was therefore never re-checked (T-CLI-3). Two
// things had to hold before that was affordable:
//
//   • no `pipeline --version` spawn on the hot path — PostToolUse fires on
//     every tool call, so a spawn there is a spawn per tool call;
//   • no flood — one line per session, not one per hook.
//
// One marker file in the system temp directory buys both. Its NAME is the
// whole mechanism: keyed on MIN_CLI_VERSION (a raised floor is a different
// file, so the check re-fires — this is the T-CLI-3 case), on the plugin root
// (version-pinned, so any plugin change is a different file too), on the
// resolved binary, and on a session-stable id, so the file dies with the
// session. Creation is an atomic `set -C` claim rather than a test-then-write,
// because Claude Code starts the two SessionStart hooks CONCURRENTLY.
// ---------------------------------------------------------------------------

describe.skipIf(!SH)('run-hook.sh once-per-session version marker (w4 / T-CLI-3)', () => {
  test('20 invocations in one session: exactly ONE --version spawn and exactly ONE warning line', () => {
    const dir = mkTmp('shim-marker-flood-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, '0.1.0');

    const env = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-flood' };
    const results = [];
    for (let i = 0; i < 20; i++) results.push(run(['hook', 'analytics-relay'], env));

    const warned = results.filter((r) => ourLines(r.stderr).length > 0);
    expect(warned.length, 'the warning flooded: it must be delivered at most once per session').toBe(1);
    expect(warned[0]!.status).toBe(1); // the one that spoke is the one that exits 1 …
    for (const r of results.filter((r) => ourLines(r.stderr).length === 0)) {
      expect(r.status).toBe(0); // … and every silent invocation is untouched
    }

    const calls = readLog(log);
    expect(calls.filter((l) => l === '--version').length, 'a --version spawn on the hot path is a spawn per tool call').toBe(1);
    expect(calls.filter((l) => l === 'hook analytics-relay').length).toBe(20); // every relay still ran
  }, 60000);

  test('T-CLI-3: a RAISED floor arriving mid-session (a /reload-plugins) re-fires the check in the SAME session', () => {
    // The scenario, precisely: the session is already running and has already
    // been checked against the shipped floor. The user runs /reload-plugins,
    // which activates a newer plugin — and a newer plugin means a newer copy
    // of this very file, with a higher MIN_CLI_VERSION literal in it.
    // SessionStart does NOT fire again, so before `w4` nothing re-checked and
    // the raised floor was ignored until the next restart.
    const dir = mkTmp('shim-marker-reload-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    // A CLI that satisfies the CURRENT floor but not a raised one.
    mkStubVersionedCli(pathDir, log, MIN_CLI_VERSION);
    const env = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-reload' };

    // ONE fixed path for every invocation below, rewritten in place between
    // them. `$0` is a marker-key component in its own right, so a "reloaded"
    // copy at a NEW path would re-fire even with floor-keying broken; holding
    // the path constant makes MIN_CLI_VERSION the only thing that varies, and
    // therefore the only thing that can explain the re-fire.
    const shim = join(dir, 'plugin', 'hooks', 'run-hook.sh');

    writeShimWithFloor(shim, MIN_CLI_VERSION);
    const before = runScript(shim, ['hook', 'analytics-relay'], env);
    expect(before.status).toBe(0);
    expect(ourLines(before.stderr)).toEqual([]); // current floor: nothing to say

    // Checked once already this session, so the marker is now claimed. If the
    // re-fire below came from anything other than the floor, this proves the
    // baseline it has to overcome.
    const cached = runScript(shim, ['hook', 'analytics-relay'], env);
    expect(ourLines(cached.stderr)).toEqual([]);

    // Same session, same temp dir, same CLI, SAME PATH — only the floor moved.
    writeShimWithFloor(shim, '99.0.0');
    const after = runScript(shim, ['hook', 'analytics-relay'], env);

    const lines = ourLines(after.stderr);
    expect(lines.length, 'a raised floor must re-fire the check without a restart — this is T-CLI-3').toBe(1);
    expect(lines[0]).toContain('older');
    expect(lines[0]).toContain('99.0.0');
    expect(after.status).toBe(1);

    // …and it stays a once-per-session message under the NEW floor too.
    const again = runScript(shim, ['hook', 'analytics-relay'], env);
    expect(ourLines(again.stderr)).toEqual([]);
    expect(again.status).toBe(0);
  }, 30000);

  test('a changed plugin root re-fires the check too (the cache is version-pinned — belt and braces with the floor)', () => {
    const dir = mkTmp('shim-marker-root-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const base = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-root' };

    const first = run(['hook', 'analytics-relay'], { ...base, CLAUDE_PLUGIN_ROOT: '/plugins/pipeline/0.98.0' });
    expect(ourLines(first.stderr).length).toBe(1);

    const same = run(['hook', 'analytics-relay'], { ...base, CLAUDE_PLUGIN_ROOT: '/plugins/pipeline/0.98.0' });
    expect(ourLines(same.stderr)).toEqual([]); // same root, same session: silent

    const upgraded = run(['hook', 'analytics-relay'], { ...base, CLAUDE_PLUGIN_ROOT: '/plugins/pipeline/0.99.0' });
    expect(ourLines(upgraded.stderr).length, 'a version-pinned plugin root change must invalidate the marker').toBe(1);
  }, 30000);

  test('a NEW session warns again: the marker is keyed on the session, not on the machine', () => {
    const dir = mkTmp('shim-marker-session-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const base = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir };

    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_CODE_SESSION_ID: 'session-one' }).stderr).length).toBe(1);
    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_CODE_SESSION_ID: 'session-one' }).stderr)).toEqual([]);
    // A second session on the same machine, same plugin, same CLI: the user
    // restarted without upgrading, and still deserves to be told.
    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_CODE_SESSION_ID: 'session-two' }).stderr).length).toBe(1);
  }, 30000);

  test('CLAUDE_PID is the fallback session key when CLAUDE_CODE_SESSION_ID is absent (it is UNDOCUMENTED — the fallback is not decorative)', () => {
    const dir = mkTmp('shim-marker-pidfallback-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const base = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir };

    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_PID: '4242' }).stderr).length).toBe(1);
    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_PID: '4242' }).stderr)).toEqual([]);
    expect(ourLines(run(['hook', 'analytics-relay'], { ...base, CLAUDE_PID: '4243' }).stderr).length).toBe(1);
  }, 30000);

  test('the marker lands in the temp dir — never in the plugin root (read-only at runtime) and never in the consumer project', () => {
    const dir = mkTmp('shim-marker-location-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, '0.1.0');

    const pluginBefore = readdirSync(PLUGIN_ROOT).sort();
    const hooksBefore = readdirSync(join(PLUGIN_ROOT, 'hooks')).sort();
    run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-loc' });

    const markers = readdirSync(tmpdir);
    expect(markers.length).toBe(1);
    expect(markers[0]!).toStartWith('pipeline-plugin-cli-check-');
    // Path separators and the Windows drive colon must not survive into the
    // name: the key is built from two absolute paths, and a `:` is illegal in
    // a Windows filename while a `/` would be a directory that does not exist.
    expect(markers[0]!).not.toContain('/');
    expect(markers[0]!).not.toContain('\\');
    expect(markers[0]!).not.toContain(':');
    // The plugin root is read-only at runtime; writing there is the bug.
    expect(readdirSync(PLUGIN_ROOT).sort()).toEqual(pluginBefore);
    expect(readdirSync(join(PLUGIN_ROOT, 'hooks')).sort()).toEqual(hooksBefore);
  }, 30000);

  test('TMPDIR, then TEMP, then TMP — each rung of the fallback is used when the ones before it are unusable (Windows Git Bash sets TEMP/TMP, not TMPDIR)', () => {
    // Each iteration points the rung under test at a real directory and every
    // EARLIER rung at one that does not exist, so the fallback is genuinely
    // exercised instead of accidentally satisfied.
    //
    // Every rung must be named explicitly, including the ones being disabled.
    // MEASURED while writing this test: Git Bash's `sh` SETS TEMP=/tmp (and
    // TMP) on its own when the parent process did not, so "leave it unset"
    // does not disable a rung on Windows — it silently redirects the marker
    // to the shared /tmp and the assertion below fails for the wrong reason.
    // (The same measurement showed MSYS rewriting `C:/x` to `/c/x` in these
    // variables, which is why the shim must never assume the value it reads
    // is in the parent's path style.)
    const rungs = ['TMPDIR', 'TEMP', 'TMP'] as const;
    for (const varName of rungs) {
      const dir = mkTmp(`shim-marker-${varName.toLowerCase()}-`);
      const pathDir = join(dir, 'pathdir');
      const log = join(dir, 'calls.log');
      const tmpdir = join(dir, 'tmp');
      const missing = join(dir, 'no-such-dir');
      mkdirSync(tmpdir, { recursive: true });
      mkStubVersionedCli(pathDir, log, '0.1.0');
      const env: Record<string, string> = { PATH: pathDir, HOME: join(dir, 'unused-home'), CLAUDE_CODE_SESSION_ID: `session-${varName}` };
      for (const r of rungs) env[r] = r === varName ? tmpdir : missing;

      expect(ourLines(run(['hook', 'analytics-relay'], env).stderr).length, `${varName} was not used as a marker location`).toBe(1);
      expect(readdirSync(tmpdir).length, `${varName} was not used as a marker location`).toBe(1);
      expect(ourLines(run(['hook', 'analytics-relay'], env).stderr)).toEqual([]);
    }
  }, 30000);

  test('every named temp variable pointing at a missing directory never crashes and never blocks — the relay is unaffected either way', () => {
    // TMPDIR/TEMP/TMP all point at a directory that does not exist, so the
    // chain falls through to its last rung, `/tmp`. On a host that HAS /tmp
    // the check proceeds normally; on one that does not, the shim cannot
    // record that it ran and therefore declines to run the check at all —
    // "say nothing" is the only safe direction, because the alternative is a
    // warning on every single tool call. Both outcomes are acceptable here;
    // what is asserted is that neither is a crash, a block, or a mangled
    // relay. (The `/tmp`-absent branch is not directly reachable from a test:
    // Git Bash and every POSIX host in CI provide one.)
    const dir = mkTmp('shim-marker-notmp-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const missing = join(dir, 'no-such-dir');
    // This is the ONE test that deliberately drives the final `/tmp` rung, so
    // it is also the one test whose marker lands outside a directory `mkTmp`
    // allocated — `afterAll`'s cleanup cannot reach it, and repeated local
    // runs otherwise accumulate zero-byte markers in the real shared /tmp
    // (11 of them after a handful of runs, on a long-lived self-hosted runner
    // unbounded). A unique session token makes the one file it creates
    // identifiable, and `sh` removes it through the SAME `/tmp` the shim
    // resolved — Node cannot name that path itself under MSYS.
    const token = `session-notmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: missing, TEMP: missing, TMP: missing, CLAUDE_CODE_SESSION_ID: token });
      expect([0, 1]).toContain(r.status);
      expect(r.stdout).toBe('RELAY-OK\n'); // the relay's own stdout, untouched
      expect(readLog(log)).toContain('hook analytics-relay'); // the relay still ran
    } finally {
      // Best-effort: the session token is the last key component, so the
      // marker name ends with it and this glob can match nothing else.
      spawnSync(SH!, ['-c', `rm -f /tmp/pipeline-plugin-cli-check-*${token}`], { encoding: 'utf8' });
    }
  }, 30000);

  // ── the invariant that outranks every line above ─────────────────────────

  test('DENY PROPAGATION survives the marker: a relay exiting 2 still exits 2, even on the invocation that would otherwise warn', () => {
    // The negative control for the whole feature. `w4` added two new ways for
    // this file to choose an exit code, and neither may ever reach a relay's
    // own status. A PreToolUse deny is a CORRECT exit 2; turning it into 1
    // would silently convert a block into a permit, which is a security
    // control failing open.
    const dir = mkTmp('shim-marker-deny-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    // Knows `hook`, is BELOW the floor, and denies. If the version warning
    // were allowed anywhere near the exit code, this would come back 1.
    mkdirSync(pathDir, { recursive: true });
    const p = join(pathDir, 'pipeline');
    writeFileSync(
      p,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'`,
        "if [ \"$1\" = \"--version\" ]; then printf '0.1.0\\n'; exit 0; fi",
        'if [ "$1" = "hook" ] && [ "$2" = "--help" ]; then printf \'pipeline hook <name>\\n\'; exit 0; fi',
        "printf 'DENY: edit is out of scope for this run\\n' >&2",
        'exit 2',
        '',
      ].join('\n'),
    );
    chmodSync(p, 0o755);

    for (const args of [['hook', 'analytics-relay'], ['--loud', 'hook', 'session-relay']]) {
      const r = run(args, { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-deny' });
      expect(r.status, `deny was not propagated for: ${args.join(' ')}`).toBe(2);
      expect(r.stderr).toContain('DENY: edit is out of scope for this run');
      expect(ourLines(r.stderr)).toEqual([]); // and no version chatter alongside it
    }
    // The version check never even ran: a non-zero relay exit routes to the
    // capability probe, not to the floor comparison, and that disjointness is
    // what keeps the two mechanisms from both speaking.
    expect(readLog(log).some((l) => l === '--version')).toBe(false);
  }, 30000);

  test('a relay exiting 0 under a CURRENT CLI is never turned into a spurious non-zero', () => {
    const dir = mkTmp('shim-marker-nofalsepos-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const tmpdir = join(dir, 'tmp');
    mkdirSync(tmpdir, { recursive: true });
    mkStubVersionedCli(pathDir, log, MIN_CLI_VERSION);
    const env = { PATH: pathDir, HOME: join(dir, 'unused-home'), TMPDIR: tmpdir, CLAUDE_CODE_SESSION_ID: 'session-clean' };
    for (let i = 0; i < 3; i++) {
      const r = run(['hook', 'analytics-relay'], env);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('RELAY-OK\n');
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// hooks/hooks.json wiring — static, runs regardless of `sh` availability
// ---------------------------------------------------------------------------

describe('hooks/hooks.json wiring', () => {
  test('all 10 hook commands route through run-hook.sh, invoke `hook <relay>`, and pin `"shell": "bash"`; no `.ts` relay path and no bare `bun ` survives', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ type?: string; command: string; shell?: string }> }>>;
    };
    const registered: Array<{ event: string; type?: string; command: string; shell?: string }> = [];
    for (const [event, entries] of Object.entries(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) registered.push({ event, ...hook });
      }
    }
    const commands = registered.map((h) => h.command);
    expect(commands.length).toBe(10);
    for (const cmd of commands) {
      expect(cmd).toContain('hooks/run-hook.sh');
      expect(/^bun[ "]/.test(cmd)).toBe(false); // the old bare-bun form must not survive anywhere
      // The relays left this repository in plugin-thin `p6`. A command still
      // naming a `.ts` file would point at something that no longer exists.
      expect(cmd, `hooks.json still invokes a .ts relay path: ${cmd}`).not.toContain('.ts');
      const invoked = RELAYS.filter((r) => cmd.endsWith(` hook ${r}`));
      expect(invoked.length, `not exactly one \`hook <relay>\` invocation in: ${cmd}`).toBe(1);
    }

    // EVERY command hook pins the shell (T-CLI-2 remedy, ROADMAP row B.5).
    // Until this assertion existed, the only thing guarding the pin was prose
    // in hooks.json's `description`, and prose does not fail CI: a new hook
    // could be added unpinned with everything green, and that single event
    // would keep the fail-open path while every other event looked fixed.
    // Omitted, Claude Code picks Git Bash on Windows and falls back to
    // PowerShell when Git Bash is absent — handing `run-hook.sh`, which is
    // POSIX sh, to a shell that cannot execute it. PR #122 measured that
    // fallback as either a hang or a dispatcher that exits 0 WITHOUT running
    // the shim, which on PreToolUse turns a deny-hook into a permit.
    for (const hook of registered) {
      expect(
        hook.shell,
        `hooks.json ${hook.event} hook is not pinned to bash: ${hook.command}\n` +
          '  Add `"shell": "bash"` beside `"type"` and `"command"` on that entry.\n' +
          '  Do NOT pin it to "powershell" — Claude Code\'s own error message suggests\n' +
          '  that, but run-hook.sh is POSIX sh and PowerShell re-opens the fail-open\n' +
          '  path this pin exists to close. Windows users need Git Bash; README says so.',
      ).toBe('bash');
    }
  });

  test('EVERY command hook carries an explicit `timeout`, in a sane range', () => {
    // Same shape, and the same argument, as the `"shell": "bash"` guard above.
    //
    // Until this assertion existed, NO hook in this file set `timeout` at all,
    // so every one inherited Claude Code's default: 600s — TEN MINUTES — on
    // every event registered here except `UserPromptSubmit`, which defaults to
    // 30s. A wedged relay could hold a turn for ten minutes. `run-hook.sh`
    // named this exact remedy in its own comments ("the lever is hooks.json's
    // per-hook `timeout` field, not shell code here") and prose does not fail
    // CI, so a hook added without one would reintroduce the ten-minute
    // exposure on that single event while every other event looked fixed —
    // the identical failure mode the bash pin's guard exists to prevent.
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: unknown }> }>>;
    };
    const registered: Array<{ event: string; command: string; timeout?: unknown }> = [];
    for (const [event, entries] of Object.entries(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) registered.push({ event, ...hook });
      }
    }
    expect(registered.length).toBe(10);

    // The bounds are the contract, not decoration. The LOWER bound keeps a
    // future edit from setting something so tight that a healthy relay is
    // cancelled on a loaded machine — a single cold invocation was measured at
    // 7.7s under a 32-way parallel-subagent wave, and the relays' cost is
    // dominated by the process spawn, not by their own work. The UPPER bound
    // is the point of the whole change: it makes "a hook may hold a turn for
    // minutes" unrepresentable in this file.
    const MIN_TIMEOUT_S = 5;
    const MAX_TIMEOUT_S = 60;
    for (const hook of registered) {
      expect(
        typeof hook.timeout,
        `hooks.json ${hook.event} hook has no \`timeout\`: ${hook.command}\n` +
          '  Add a `"timeout": <seconds>` beside `"type"`, `"command"` and `"shell"`.\n' +
          '  Without it the hook inherits Claude Code\'s default — 600s on every event\n' +
          '  here except UserPromptSubmit (30s) — so a wedged relay holds the turn for\n' +
          '  ten minutes. See hooks.json\'s `description` for the measured budget.',
      ).toBe('number');
      const t = hook.timeout as number;
      expect(Number.isInteger(t), `hooks.json ${hook.event} timeout is not a whole number of seconds: ${t}`).toBe(true);
      expect(
        t >= MIN_TIMEOUT_S && t <= MAX_TIMEOUT_S,
        `hooks.json ${hook.event} timeout ${t}s is outside ${MIN_TIMEOUT_S}-${MAX_TIMEOUT_S}s: ${hook.command}\n` +
          `  Below ${MIN_TIMEOUT_S}s a healthy relay gets cancelled on a loaded machine.\n` +
          `  Above ${MAX_TIMEOUT_S}s this file is back to letting a hook stall a turn for\n` +
          '  minutes, which is the exposure the timeouts were added to close.',
      ).toBe(true);
    }
  });

  test('every relay this plugin depends on is actually registered somewhere', () => {
    // The inverse of the check above: a relay that no hook event invokes is a
    // relay that silently never runs, which for the journal writers means the
    // telemetry chain stops with no test failing.
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    for (const relay of RELAYS) {
      expect(raw, `no hooks.json command invokes \`hook ${relay}\``).toContain(` hook ${relay}`);
    }
  });

  test('--loud appears on exactly one SessionStart entry', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands: string[] = [];
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) commands.push(hook.command);
      }
    }
    const loudCount = commands.filter((c) => c.includes('--loud')).length;
    expect(loudCount).toBe(1); // two loud SessionStart entries would print the warning twice per session
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.command).toContain('--loud');
  });
});

// ---------------------------------------------------------------------------
// committed file mode — a non-executable shim reintroduces the exact bug
// ---------------------------------------------------------------------------

describe('hooks/run-hook.sh committed file mode', () => {
  test('git tracks the shim as mode 100755 (executable)', () => {
    const r = spawnSync('git', ['ls-files', '-s', 'hooks/run-hook.sh'], { cwd: PLUGIN_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^100755\s/);
  });
});
