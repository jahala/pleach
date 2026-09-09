#!/usr/bin/env bash
# A smoke that prints ordinary test output — the common case. Nothing is a
# findings log, so nothing is kept and the receipt is byte-identical to one
# minted before gate artifacts existed (ledger D14).

set -euo pipefail

echo "1 test passed"
