#!/usr/bin/env bash
# Work that leaves a friction journal in the tree, the way weeder/tend2 do
# (ledger D14). Collection sets `.plotplot/friction/` aside before staging, so
# the journal reaches settle uncommitted — the case pleach keeps beside the
# receipt as `<node>.friction.jsonl`.

set -euo pipefail

echo made > out.txt
mkdir -p .plotplot/friction
echo '{"at":"2026-09-10T00:00:00Z","kind":"retry","rule":"S2"}' > .plotplot/friction/2026-09.jsonl
