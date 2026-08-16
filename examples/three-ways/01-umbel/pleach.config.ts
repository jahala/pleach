import { gitLedger } from 'pleach/adapters/git';
import { umbelRunner } from 'pleach/adapters/umbel';
import type { PleachConfig } from 'pleach/config';

// Proof 1 — the strict rig, without a tend instance.
//
// umbel drives the interactive agent CLIs (claude builds, codex audits) in tmux;
// gitLedger records the verified close as node/* branches on plain git. The gate is a
// standalone discriminating audit (payload/project/strict-audit.sh) — tend's negctrl in
// ~20 lines of bash — so no missoula/tend instance is needed. tend is the production
// verifier (docs/research/proof-run.md); this proves the same shape runs on the bundled
// umbel + git adapters alone.
export default {
  runner: umbelRunner({
    bin: process.env.UMBEL_BIN ?? 'umbel',
    permissionMode: 'bypassPermissions',
  }),
  ledger: gitLedger(),
} satisfies PleachConfig;
