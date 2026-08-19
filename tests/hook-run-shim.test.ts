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
 *     so it never gets classified as "no hook subcommand"). `--loud` only,
 *     and only once the primary `hook` call already succeeded: older prints
 *     exactly one upgrade line to STDERR (never stdout — that channel is
 *     asserted directly, since a SessionStart hook's stdout becomes
 *     additionalContext, not a guaranteed user-facing banner); equal and
 *     newer are silent; a `--version` output that doesn't parse as this
 *     CLI's real shape (bare `N.N.N`) is UNKNOWN — reported once, never
 *     treated as "too old". Quiet mode never even spawns `--version`. A
 *     dedicated test proves the two old-CLI mechanisms are disjoint: a CLI
 *     with no `hook` at all never reaches the version check, even though it
 *     would also fail `--version`.
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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  const script = ['#!/bin/sh', `printf 'STUB=${label} ARGS=%s\\n' "$*"`, 'IFS= read -r line', "printf 'STDIN=%s\\n' \"$line\"", `exit ${exitCode}`, ''].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Runs run-hook.sh under `sh` with a FULLY explicit env (never inherits the
 *  real PATH/HOME — this test's whole point is controlling candidate
 *  resolution precisely). */
function run(args: string[], env: Record<string, string>, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(SH!, [SCRIPT, ...args], { env, input: stdin, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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

  test('pipeline not found, --loud (SessionStart primary entry only): exits 0 with exactly ONE line that names the install command', () => {
    const dir = mkTmp('shim-notfound-loud-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0);
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

  test('OLD CLI, --loud (SessionStart): exit 0 plus exactly ONE line naming the upgrade command', () => {
    const dir = mkTmp('shim-oldcli-loud-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubOldCli(pathDir, log);
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const ours = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
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

  test('success costs nothing: a relay that exits 0 is never probed (one spawn, as before the fix)', () => {
    const dir = mkTmp('shim-newcli-ok-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubNewCli(pathDir, log, 0);
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(readLog(log)).toEqual(['hook analytics-relay']); // no probe on the hot path
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
  test('older than MIN_CLI_VERSION, --loud: exactly ONE line, on STDERR (not stdout-to-context), naming the upgrade command', () => {
    const dir = mkTmp('shim-minver-older-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '0.1.0'); // below any real MIN_CLI_VERSION
    const r = run(['--loud', 'hook', 'session-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0); // never blocks the session
    expect(r.stdout).not.toContain('pipeline plugin:'); // the channel: NOT stdout-to-context
    const lines = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
    expect(lines.length).toBe(1); // exactly one line
    expect(lines[0]).toContain('older');
    expect(lines[0]).toContain('0.1.0');
    expect(lines[0]).toContain('@baizor/pipeline');
    expect(lines[0]).toContain('bun add -g');
  }, 15000);

  test('older than MIN_CLI_VERSION, quiet (every hook except the primary SessionStart entry): silent, and --version is never even spawned', () => {
    const dir = mkTmp('shim-minver-older-quiet-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    mkStubVersionedCli(pathDir, log, '0.1.0');
    const r = run(['hook', 'analytics-relay'], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('RELAY-OK\n');
    expect(r.stderr).toBe('');
    expect(readLog(log)).toEqual(['hook analytics-relay']); // no --version spawn on the hot path
  }, 15000);

  test('equal to MIN_CLI_VERSION, --loud: silence (current, not "too old")', () => {
    const dir = mkTmp('shim-minver-equal-');
    const pathDir = join(dir, 'pathdir');
    const log = join(dir, 'calls.log');
    const src = readFileSync(SCRIPT, 'utf-8');
    const minVersion = /MIN_CLI_VERSION="([0-9.]+)"/.exec(src)?.[1];
    if (!minVersion) throw new Error('could not read MIN_CLI_VERSION out of run-hook.sh');
    mkStubVersionedCli(pathDir, log, minVersion);
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
    expect(r.status).toBe(0); // unknown must never block
    const lines = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
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
    expect(r.status).toBe(0);
    const lines = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
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
    expect(r.status).toBe(0);
    const lines = r.stderr.split('\n').filter((l) => l.includes('pipeline plugin:'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('too old');
    expect(lines[0]).not.toContain('could not read');
    expect(lines[0]).not.toContain('is older than this plugin needs');
    expect(readLog(log).some((l) => l.startsWith('--version'))).toBe(false); // never spawned
  }, 15000);
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
