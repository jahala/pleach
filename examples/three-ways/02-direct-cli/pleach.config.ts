import { directCliRunner } from 'pleach/adapters/direct-cli';
import { gitLedger } from 'pleach/adapters/git';
import type { PleachConfig } from 'pleach/config';

// Proof 2 — the lean profile (now the BUNDLED direct-CLI adapter).
//
// No umbel, no tmux, no tend. directCliRunner (src/adapters/direct-cli.ts)
// shells `claude -p` for each build node and `codex exec` for the cross-provider
// audit, headless; gitLedger records the verified close as node/* branches on plain
// git. The plan and the gate ladder are identical to every other profile — the
// runner is the only thing that changed. (This config file is now optional:
// `pleach run --runner direct-cli` selects the same pairing with no config.)
// To adapt for another provider, copy src/adapters/direct-cli.ts into your own
// config and extend its argv table.
//
// Providers come from the plan: build nodes leave worker.provider unset, so the
// runner defaults them to claude; the audit node pins provider: "codex".
export default {
  runner: directCliRunner(),
  ledger: gitLedger(),
} satisfies PleachConfig;
