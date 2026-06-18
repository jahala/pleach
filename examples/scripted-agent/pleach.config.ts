import { gitLedger } from 'pleach/adapters/git';
import { scriptedAuditResult, scriptedRunner } from 'pleach/adapters/scripted';
import type { PleachConfig } from 'pleach/config';

// A deterministic, no-LLM config. The scripted runner stands in for an agent
// CLI: it applies canned worktree changes for each build prompt and returns a
// passing cross-provider audit, so the whole gate ladder (work → smoke → audit)
// runs end-to-end with no external runner binary and no API keys.
//
// To drive REAL agents, swap `scriptedRunner` for `umbelRunner` (or your own
// RunnerSeam) — the plan and the ledger stay exactly the same. Scenarios are
// matched first-wins: builds by a prompt substring, the cross-provider auditor
// by its provider.
export default {
  runner: scriptedRunner([
    {
      prompt: 'Implement',
      files: {
        'wc.ts': 'export const wc = (s: string) => s.trim().split(/\\s+/).filter(Boolean).length;\n',
      },
      message: 'implemented wordcount',
    },
    {
      prompt: 'Harden',
      files: {
        'wc.test.ts': "import { wc } from './wc.ts';\nif (wc('a b  c') !== 3) throw new Error('wc broken');\n",
      },
      message: 'hardened wordcount',
    },
    {
      provider: 'codex',
      message: scriptedAuditResult([{ check: 'wordcount-works', verdict: 'pass' }]),
    },
  ]),
  ledger: gitLedger(),
} satisfies PleachConfig;
