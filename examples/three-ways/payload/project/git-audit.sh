#!/usr/bin/env bash
# git-audit.sh — a standalone, tend-free cross-provider audit for the three-ways proofs.
#
# pleach sends this command to the AUDITOR agent (a different vendor than the builder),
# wrapped by buildAuditPrompt(); the auditor runs it and reproduces the
# ```tend-audit-result``` block below verbatim as the final content of its reply.
# pleach parses THAT block (extractAuditJson) — never the agent's prose. So the audit is
# a deterministic command run in an independent session: the cross-provider guarantee is
# execution isolation, not model judgment. (tend's `tend audit` adds negctrl
# discrimination on top; this lighter check just attests the suite runs green in a fresh
# checkout — see examples/three-ways/01-umbel for the strict version.)
set -uo pipefail

check="${1:-ttt}"

if bun test >/tmp/three-ways-audit.log 2>&1; then
  printf '```tend-audit-result\n{"verdicts":[{"check":"%s","verdict":"pass","reasons":[]}],"drift":[]}\n```\n' "$check"
else
  printf '```tend-audit-result\n{"verdicts":[{"check":"%s","verdict":"fail","reasons":["bun test failed in the audit checkout"]}],"drift":[]}\n```\n' "$check"
fi
