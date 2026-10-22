import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Version guard: the canonical text may only change when its version line
// changes too. A reader pins "plan schema v1.1.x" by the version number alone,
// so the version number must move with every edit to the canonical text —
// including the informative seam block tend and umbel vendor verbatim (issue
// #123: `idleMs` slipped into v1.1.5 without a bump). The comparison is against
// the commit that last changed the version line, found with `git log -G`.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, '../..');
const CONTRACT_REL = 'docs/contract/plan-schema.md';
const CONTRACT_PATH = join(ROOT, CONTRACT_REL);

// Same regex the git -G pickaxe uses; '.' is a metacharacter matching the
// backtick in the title line `# `@agent-contract/plan` v1.1.5 — canonical text`.
const VERSION_LINE_RE = /@agent-contract\/plan. v/;

function git(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

function versionLine(text: string): string | undefined {
  return text.split('\n').find((line) => VERSION_LINE_RE.test(line));
}

describe('plan schema version guard', () => {
  test('the canonical text only changes when its version line changes too', () => {
    const shallow = git(['rev-parse', '--is-shallow-repository']);
    if (shallow.stdout.trim() === 'true') {
      throw new Error(
        'plan-schema version guard needs full git history: this checkout is shallow, so the ' +
          'commit that last changed the version line may be missing and the comparison would pass ' +
          'vacuously. Clone with full history (CI: actions/checkout with fetch-depth: 0).',
      );
    }

    const sha = git(['log', '-1', '--format=%H', '-G@agent-contract/plan. v', '--', CONTRACT_REL]);
    if (sha.exitCode !== 0 || sha.stdout.trim() === '') {
      throw new Error(
        `plan-schema version guard could not find the commit that last changed the version line ` +
          `(git log -G exited ${sha.exitCode}): ${sha.stderr || sha.stdout}`,
      );
    }

    const working = readFileSync(CONTRACT_PATH, 'utf8').replace(/\r\n/g, '\n');

    const pinned = git(['show', `${sha.stdout.trim()}:${CONTRACT_REL}`]);
    if (pinned.exitCode !== 0) {
      throw new Error(
        `plan-schema version guard: git show failed (exit ${pinned.exitCode}): ${pinned.stderr}`,
      );
    }
    const pinnedText = pinned.stdout.replace(/\r\n/g, '\n');

    const workingVersion = versionLine(working);
    const pinnedVersion = versionLine(pinnedText);

    if (workingVersion !== pinnedVersion) {
      return; // the version line moved — a sanctioned bump
    }

    if (working !== pinnedText) {
      throw new Error(
        `docs/contract/plan-schema.md changed without a version bump.\n` +
          `  version line: ${workingVersion ?? '(not found)'}\n` +
          `  last version-line commit: ${sha.stdout.trim()}\n` +
          `  fix: bump the version line and add a docs/contract/CHANGES.md entry.`,
      );
    }
  });
});
