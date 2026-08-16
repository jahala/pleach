import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';
import { directCliRunner } from '../lib/direct-cli-runner.ts';

// Proof 2 — bring your own runner.
//
// No umbel, no tmux, no tend. The directCliRunner (../lib/direct-cli-runner.ts)
// shells `claude -p` for each build node and `codex exec` for the cross-provider
// audit, headless; gitLedger records the verified close as node/* branches on plain
// git. The plan and the gate ladder are identical to every other profile — the
// runner is the only thing that changed.
//
// Providers come from the plan: build nodes leave worker.provider unset, so the
// runner defaults them to claude; the audit node pins provider: "codex".
export default {
  runner: directCliRunner(),
  ledger: gitLedger(),
} satisfies PleachConfig;
