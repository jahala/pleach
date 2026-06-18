# command-dag — verified shell commands, no runner

The smallest end-to-end pleach run: a DAG of plain `{command}` nodes. Because
command work execs directly, **no agent runner is spawned** — this plan runs
with nothing but `git` and `bun`. No agent CLI, no API keys, no config.

It exercises the four guarantees that make pleach more than a task runner:

| node | work | shows |
|------|------|-------|
| `lib` | writes `build.sh` | a node produces a verified artifact |
| `check` (needs `lib`) | runs `build.sh` | a dependent only sees `lib`'s work because `lib` **verified first** |
| `broken` | `exit 1` | a failed gate is **quarantined** — no `node/broken` branch is published |
| `dependent` (needs `broken`) | — | a dependent of a quarantined node is **skipped**, never run |

## Run it

Against a throwaway git repo (worktrees and `node/<id>` branches land there):

```bash
repo=$(mktemp -d)
git -C "$repo" init -q
echo init > "$repo/init.txt"
git -C "$repo" add -A
git -C "$repo" commit -q -m init

pleach run examples/command-dag/plan.json --repo-root "$repo"
```

Expected summary on stdout:

```json
{ "closed": ["check", "lib"], "failed": ["broken"], "partial": [], "skipped": ["dependent"], "blocked": [] }
```

Exit code is `1` (not every node closed — `broken` failed by design). The
verified nodes are published as branches you can merge yourself:

```bash
git -C "$repo" branch --list 'node/*'   # node/lib, node/check — and NOT node/broken
```

Nothing is published for `broken`, and `dependent` never executed — garbage
cannot propagate down the DAG.
