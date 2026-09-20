# Security policy

## Supported versions

pleach is pre-1.0. Security fixes land on `master` and the latest tag.

| Version | Supported |
|---|---|
| latest `master` | yes |
| older tags | no |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Open a [GitHub private security advisory](https://github.com/jahala/pleach/security/advisories/new), or
- email **jan@m-a-d.co**.

You'll get an acknowledgement within a few days and updates as the fix progresses.

## Trust model

pleach is a conductor for **agent-produced code**: it spawns agent workers, runs their work in disposable git worktrees, executes setup / smoke / audit commands, and merges only verified branches. By design it **executes untrusted, model-generated code and shell commands**. Run it only where that is acceptable.

- Each node runs in a detached, disposable git worktree merged from its dependencies' verified branches.
- The gates (conflict-marker scan, smoke, cross-provider audit) and the deterministic loop decide what publishes — agent output is parsed evidence, never trusted control flow.
- pleach does **not** sandbox the worker itself; isolating the host (containers, VMs, restricted permissions) is the operator's responsibility. Workers spawn `--unattended` by default and no permission mode is set unless you pass
  `--permission-mode`; either way the assumption is that external safety is in place.

Treat a pleach run like a CI job that executes arbitrary code: give it only the access it needs.
