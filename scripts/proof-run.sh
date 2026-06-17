#!/usr/bin/env bash
# proof-run.sh — run the pleach wordcount proof end-to-end.
#
# Usage:
#   bash scripts/proof-run.sh [--skip-setup] [--max-concurrency N]
#
# Requires:
#   - rctrl on PATH (or PLEACH_RCTRL_BIN set)
#   - bun on PATH
#   - tmux (rctrl's substrate)
#   - The missoula tend checkout (path given in $PLEACH_TEND_MODULE)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLEACH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEND_MODULE="${PLEACH_TEND_MODULE:?set PLEACH_TEND_MODULE to your tend ingester path}"
PROOF_DEST=/tmp/pleach-proof-wordcount
RCTRL_BIN="${PLEACH_RCTRL_BIN:-rctrl}"
MAX_CONCURRENCY="${2:-2}"
SKIP_SETUP=0

for arg in "$@"; do
  case "$arg" in
    --skip-setup) SKIP_SETUP=1 ;;
    --max-concurrency) shift; MAX_CONCURRENCY="$1" ;;
  esac
done

echo "=== pleach proof run ===" >&2
echo "  repo-root: $PROOF_DEST" >&2
echo "  tend-module: $TEND_MODULE" >&2
echo "  rctrl: $RCTRL_BIN" >&2
echo "  max-concurrency: $MAX_CONCURRENCY" >&2
echo "" >&2

# Step 1: setup standalone wordcount repo
if [[ "$SKIP_SETUP" -eq 0 ]]; then
  echo "[setup] initialising standalone wordcount repo at $PROOF_DEST ..." >&2
  bun "$PLEACH_ROOT/scripts/proof-setup.ts" "$PROOF_DEST"
  echo "[setup] done." >&2
else
  echo "[setup] skipped (--skip-setup)" >&2
fi

# Step 2: write the runtime plan (absolute paths)
RUNTIME_PLAN="$PROOF_DEST/proof-plan.json"
cat > "$RUNTIME_PLAN" <<PLAN
{
  "goal": "Complete the wordcount library: add countLines, countChars, and a stats() aggregator — test-first — so the feature passes the codex audit.",
  "source": "${PROOF_DEST}/docs/tend/features/wordcount.tend.html",
  "nodes": [
    {
      "id": "wordcount.s1",
      "work": {
        "prompt": "You are implementing a TypeScript/Bun library feature test-first.\n\nProject: a wordcount library. File to extend: src/count.ts. Test file: test/count.test.ts.\n\nYour task — implement countLines (test-first):\n\n1. In test/count.test.ts, ADD (do not replace existing tests) a describe('countLines', ...) block with failing tests FIRST:\n   - countLines('') === 0\n   - countLines('hello') === 1  (single line, no trailing newline)\n   - countLines('a\\nb') === 2\n   - countLines('a\\nb\\n') === 2  (trailing newline does not add a line)\n\n2. Confirm tests fail: run \`bun test test/count.test.ts\` — the new describe block must fail.\n\n3. In src/count.ts, ADD (do not modify countWords) this function:\n   export function countLines(text: string): number\n   Semantics: count newline-separated segments; trailing newline does not add an empty final line.\n\n4. Run \`bun test\` — all tests must pass. Fix any issues.\n\nConstraints: do NOT modify or delete countWords or its tests. Export countLines from src/count.ts."
      },
      "setup": "bun install",
      "needs": [],
      "accept": { "smoke": "bun test" },
      "policy": { "timeoutMs": 600000 }
    },
    {
      "id": "wordcount.s2",
      "work": {
        "prompt": "You are implementing a TypeScript/Bun library feature test-first.\n\nProject: a wordcount library. File to extend: src/count.ts. Test file: test/count.test.ts.\n\nYour task — implement countChars (test-first):\n\n1. In test/count.test.ts, ADD (do not replace existing tests) a describe('countChars', ...) block with failing tests FIRST:\n   - countChars('') === 0\n   - countChars('hello') === 5\n   - countChars('hi\\nthere') === 8  (newline counts as 1 character)\n   - countChars('  ') === 2  (spaces count)\n\n2. Confirm tests fail: run \`bun test test/count.test.ts\` — the new describe block must fail.\n\n3. In src/count.ts, ADD (do not modify countWords) this function:\n   export function countChars(text: string): number\n   Semantics: count every character including whitespace and newlines (i.e. text.length).\n\n4. Run \`bun test\` — all tests must pass. Fix any issues.\n\nConstraints: do NOT modify or delete countWords or its tests. Export countChars from src/count.ts."
      },
      "setup": "bun install",
      "needs": [],
      "accept": { "smoke": "bun test" },
      "policy": { "timeoutMs": 600000 }
    },
    {
      "id": "wordcount",
      "work": {
        "prompt": "You are completing a TypeScript/Bun wordcount library.\n\nThis worktree has been merged from two independent branches: one added countLines, one added countChars. Your task:\n\n1. Check for merge conflicts: run \`git diff --check\`. If conflicts exist in src/count.ts or test/count.test.ts, resolve them — keep ALL four functions (countWords, countLines, countChars, and the stats() you will add) and ALL their tests.\n\n2. Run \`bun test\` to confirm the existing suite passes before adding stats().\n\n3. In src/count.ts, ADD this aggregator function (do not modify countWords/countLines/countChars):\n   export function stats(text: string): { words: number; lines: number; chars: number } {\n     return { words: countWords(text), lines: countLines(text), chars: countChars(text) };\n   }\n\n4. In test/count.test.ts, ADD a describe('stats', ...) block:\n   - stats('') === { words: 0, lines: 0, chars: 0 }\n   - stats('hello\\nworld') === { words: 2, lines: 2, chars: 11 }\n\n5. Run \`bun test\` — ALL tests must pass. Fix any issues.\n\nFiles you may edit: src/count.ts, test/count.test.ts. Do not add new files."
      },
      "setup": "bun install",
      "needs": ["wordcount.s1", "wordcount.s2"],
      "accept": {
        "smoke": "bun test",
        "audit": {
          "command": "tend audit wordcount",
          "provider": "codex"
        }
      },
      "policy": { "timeoutMs": 600000 },
      "closes": []
    }
  ]
}
PLAN

echo "[plan] wrote $RUNTIME_PLAN" >&2

# Step 3: validate before running
echo "[validate] checking plan..." >&2
bun "$PLEACH_ROOT/src/main.ts" validate "$RUNTIME_PLAN"
echo "[validate] ok." >&2

# Step 4: run the proof
echo "[run] starting pleach run..." >&2
JOURNAL="$PROOF_DEST/proof-journal.jsonl"

bun "$PLEACH_ROOT/src/main.ts" run "$RUNTIME_PLAN" \
  --repo-root "$PROOF_DEST" \
  --max-concurrency "$MAX_CONCURRENCY" \
  --tend-module "$TEND_MODULE" \
  --rctrl-bin "$RCTRL_BIN" \
  --journal "$JOURNAL" \
  --permission-mode bypassPermissions
