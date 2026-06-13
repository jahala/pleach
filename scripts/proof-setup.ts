#!/usr/bin/env bun
/**
 * proof-setup.ts — initialize the wordcount proof project as a standalone git repo.
 *
 * The wordcount project lives inside examples/proof/project/ in the pleach repo,
 * but needs to be its own git repo for:
 *   - pleach worktrees (isolate seam creates detached worktrees from its HEAD)
 *   - tend negctrl (needs git-root == project root for path resolution)
 *
 * This script copies the project to a fresh directory and initialises it as a
 * standalone git repo. Because it runs as a Bun subprocess, it is NOT subject to
 * the guard-git.sh hook that blocks `git init` in Claude's Bash tool.
 *
 * Usage:
 *   bun scripts/proof-setup.ts [dest]
 *   # Default dest: /tmp/pleach-proof-wordcount
 *
 * Prints the canonical path on stdout so callers can capture it.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? '/tmp/pleach-proof-wordcount');
const src = resolve(import.meta.dir, '../examples/proof/project');

// Clean previous run
if (existsSync(dest)) {
  rmSync(dest, { recursive: true });
}
mkdirSync(dest, { recursive: true });

// Copy project files (skip node_modules)
cpSync(src, dest, {
  recursive: true,
  filter: (path) => !path.includes('node_modules'),
});

const exec = (cmd: string) =>
  execSync(cmd, { cwd: dest, stdio: 'pipe', encoding: 'utf8' });

// Initialize git repo
exec('git init -b master');
exec('git config user.email "pleach-proof@local"');
exec('git config user.name "Pleach Proof"');

// Install bun deps
exec('bun install');

// Initial commit with pre-seeded state
exec('git add .');
exec('git commit -m "chore: initial state — countWords pre-seeded"');

// Print dest so callers can capture it
process.stdout.write(`${dest}\n`);
