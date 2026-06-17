# pleach — voice delta

Inherits the plotplot umbrella voice (calm · precise · literate · a little wit). One signature line and a terminology table, merged with the umbrella at read time.

**Signature phrase:** *agents produce; code decides.*

## Terminology

| Use | Not | Why |
|---|---|---|
| conductor | orchestrator, runner | pleach conducts a plan deterministically; it doesn’t just run steps. |
| gate | hook, step | The deterministic bars a node must clear before it can publish. |
| verified | done, finished, passing | Audited and closed by code — never the green an agent graded itself. |
| `node/<id>` branch | output, artifact, result | The single thing pleach publishes, and only for verified work. |
| quarantine | block, fail-stop | A failed node publishes nothing; its dependents are skipped, not built on a bad base. |
| plan / DAG | pipeline, workflow | The input pleach conducts — a graph of nodes, not a linear script. |
| node | task, job | One unit of agent work in the plan. |

Product name is lowercase always: `pleach`.
