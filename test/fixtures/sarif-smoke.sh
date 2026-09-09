#!/usr/bin/env bash
# A smoke that prints a SARIF 2.1.0 findings log to stdout — what `weeder check
# --strict` prints when stdout is a pipe (ledger D14). The stderr line is the
# point of the fixture: the bytes pleach keeps and hashes are stdout alone,
# never the two streams as the gate saw them interleaved.

set -euo pipefail

echo "weeder: judging the staged diff" >&2
cat "$(dirname "$0")/weeder-check.sarif"
