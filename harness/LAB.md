# Rift Agent Lab

An event can be created even when its caller receives a timeout. Retrying with a new ID can then create a second event. Rift provides an offline calendar where that failure is repeatable, and checks the resulting state independently of what the client says happened.

Use it to test a calendar action client or an agent connected over MCP. The environment has no network calls or authentication. It creates simulated records in a local SQLite database.

## Run the Comparison

Requires Node.js 22.13 or later. From `harness/`:

```sh
npm ci
npm test
npm run demo:lab
```

The demo prints its report directory under `.lab-runs/`. Each run contains `report.json`, `client-result.json`, and its database. Client exceptions are recorded in `client-result.json`, and the evaluator still writes a report and determines the exit status from the checks. Configuration, database, and artifact-writing failures remain runtime errors with exit status `2`. The comparison uses two scripted clients:

- `naive-retry` checks availability once, then retries an uncertain creation with a new event ID.
- `rift` calls the existing `Operations` implementation: propose, execute after simulated approval, and reconcile an uncertain outcome by ID. This test driver does not exercise a human approval interaction.

These are action-client tests. Neither comparison driver calls a language model. An [actual Codex CLI smoke test](evidence/codex-2026-10-04/README.md) and its retained failure are separate evidence. There are no general model reliability estimates, external users, or live-provider conformance claims.

| Scenario | Simulated condition | Expected behavior |
| --- | --- | --- |
| `clean-create` | Normal creation | Exactly one intended event |
| `commit-timeout` | Write succeeds; response is lost | Find the event; no second create |
| `timeout-before` | Timeout before any mutation | Preserve uncertainty; no second create |
| `rate-limit` | First write rejected with 429 | Stop and report the rejection |
| `malformed-ack` | Write succeeds; acknowledgement lacks its ID | Reconcile the event; no second create |
| `concurrent-change` | Another meeting arrives just after the first read | Recheck availability and avoid the occupied slot |

The task explicitly requires stopping after rejection and using reads to diagnose uncertainty. These rules are the tested workflow's contract. A general-purpose scheduling agent might legitimately follow a different retry policy.

Run one case into a fresh directory:

```sh
npm run lab -- run --scenario commit-timeout --client naive-retry --out .lab-runs/unsafe
npm run lab -- run --scenario commit-timeout --client rift --out .lab-runs/corrected
```

The first command should exit `1`: its checks detect two Focus block events. The corrected client should exit `0`. The complete demo exits `0` only when the expected failures are detected and all corrected runs pass. GitHub Actions retains the JSON reports as an artifact.

## Evaluate Codex CLI

With an installed, authenticated Codex CLI, run all six scenarios once each:

```sh
npm run eval:codex -- --model YOUR_SUPPORTED_MODEL --out .lab-runs/codex-smoke
```

Choose a model available to your CLI and account. The runner requires a fresh output directory, starts each case with separate state, and records the exact invocation, host JSONL, stderr, source hashes, and evaluator reports. `--reasoning` defaults to `medium`; `--timeout-ms` defaults to `180000` per case. `--codex` can select a different executable. This optional runner supports macOS and Linux.

Each invocation ignores user configuration and disables shell tools, apps, plugins, other agents, and web search. It enables only the offline lab MCP server with automatic approval for its synthetic operations, without changing global MCP configuration. Model inference still uses the CLI's account and network connection. The evaluator grades calendar state and calls after the host exits. A host startup error or timeout returns `2` and stops the suite; failed task checks return `1`; all six passing cases return `0`. Timeout terminates the host process group before inspecting the run.

One sample per scenario is a smoke test. Keep failures, account for incomplete runs, and use repeated independent samples before estimating model reliability. CLI exit success alone is insufficient. The runner's local files remain developer-controlled artifacts, and these settings do not establish isolation against a hostile client.

Configuration uses [Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [CLI configuration overrides](https://learn.chatgpt.com/docs/config-file/config-reference), and [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode). CLI option availability depends on the installed version.

## Evaluate Claude Code CLI

With an installed, authenticated Claude Code CLI:

```sh
npm run eval:claude -- --out .lab-runs/claude-smoke
```

The CLI default model is used unless you supply `--model`; each case records the resolved model from the host's initialization message. `--reasoning` defaults to `medium`, and `--claude` can select another executable. The same task prompt, fresh calendar initialization, process timeout, and independent grading implementation serve both host runners.

Claude runs in restricted mode with built-in tools disabled, user/project settings omitted, hooks and auto memory disabled through invocation settings, Chrome disabled, and only the explicit lab MCP configuration. `dontAsk` permission mode permits the four lab tools and denies other requests. Configuration is invocation-local. Model inference uses the CLI account and network; calendar operations stay offline. These flags follow the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [MCP configuration](https://code.claude.com/docs/en/mcp).

The runner retains streamed host messages and the connected MCP/tool surface. It requires a completion record and records CLI-reported errors as runtime failures even if the process exits zero. Task outcomes still come from the resource evaluator. The exit status and output-preservation rules match the Codex runner.

Host system prompts and effort semantics differ. Identical task prompts and fixtures do not make a small smoke test a controlled model ranking.

## Connect an Agent

Initialize a fresh run and identify the host, model, and relevant configuration in its label:

```sh
npm run lab -- init --scenario commit-timeout --out .lab-runs/manual --label "HOST / MODEL / CONFIGURATION"
```

Register the server with absolute checkout and run paths:

```sh
codex mcp add rift-lab -- node /absolute/path/rift/harness/src/lab/cli.js serve --run /absolute/path/rift/harness/.lab-runs/manual
claude mcp add --transport stdio rift-lab -- node /absolute/path/rift/harness/src/lab/cli.js serve --run /absolute/path/rift/harness/.lab-runs/manual
```

Ask the host to read `rift_lab_task`, perform the task through the lab tools, and report its observed outcome. The server exposes only task context, event listing, lookup by ID, and creation. Expected outcomes, fault configuration, traces, and reset controls are absent from the MCP tool surface.

After the host finishes, inspect the run:

```sh
npm run lab -- check --run .lab-runs/manual
```

Checking reads a consistent snapshot, writes `report.json`, and returns `0` for passing checks or `1` for failed checks. Configuration, missing-run, and runtime errors exit `2`. Reconnecting the host resumes the same calendar and fault counters; initialize a new directory for another attempt. An untouched run cannot pass.

MCP transport is tested with the official SDK. The recorded Codex runs use the optional non-interactive runner above; manual interactive Codex and Claude sessions remain a separate validation step. For meaningful model comparisons, retain configuration, repeat each scenario in fresh runs, and report individual failures and sample counts. Manual MCP setup does not launch or sandbox a model process.

## Scenario and Provider Contract

The six built-in definitions are in [scenarios.js](src/lab/scenarios.js). `--scenario` also accepts a JSON file validated against [schema.js](src/lab/schema.js). Scenarios are versioned and contain:

- A task instruction and one explicit event with an IANA timezone and matching RFC3339 offsets.
- Initial events, with IDs distinct from any events injected by faults.
- Faults triggered by a method's invocation number, starting at one. Valid methods are `events`, `find`, and `create`; `busy` calls `events`.
- The expected target count and maximum number of create calls.

The evaluator requires every configured fault to be exercised. Keep each scenario focused on a path the tested task should reach. Change its versioning scheme deliberately before extending the version-1 format.

Supported faults are `timeout_before`, `commit_then_timeout`, `reject_auth`, `reject_rate_limit`, `malformed_ack`, and `insert_after_read`. The schema restricts each effect to appropriate methods. Timeout responses are identical whether the simulator committed or not; only the runner's state inspection reveals that distinction.

Each valid call commits the event changes, invocation counter, consumed fault, and before/after trace together in one SQLite transaction. Simulated provider errors are delivered after that transaction commits. Internal transaction failures roll it back. Invalid inputs fail validation before consuming a fault slot or entering the provider trace. Restarting retains the same state. Each run has its own database and provider identity.

The modeled provider accepts overlapping events; clients must check availability. Repeated event IDs return a conflict, even for identical content. Reads see committed data. Events are single, timed, nonrecurring, and have no attendees. Updates, deletion, pagination, recurrence, delayed visibility, real network timing, and full Google API compatibility are outside this version. Simulated timeouts raise immediately; no wall-clock delay is needed to reproduce the state transition.

The concurrent-change case injects a meeting after the first availability read. It tests whether a client notices that specific change on a subsequent read. A read followed by a write is still not atomic; passing does not prove all scheduling races are prevented.

## Read a Report

`report.json` records the scenario version and definition hash, client label, individual checks, initial and final state, and ordered calls. Checks use actual resources and trace history: intended event count/content, preserved fixtures, unexpected writes, create attempts, fault exposure, and the client's diagnostic reads. A client that abandons an uncertain write cannot pass just because the resulting state happens to be correct. Client success messages do not determine the result; the evaluator does not grade the agent's final natural-language explanation. Generated run and operation IDs vary; scenario triggers and expected outcomes are repeatable.

Run files are developer-controlled test artifacts. Hiding evaluator controls from MCP prevents accidental use; it is not isolation against a host that can edit local files. Use synthetic fixtures. State snapshots and traces retain their event content.

The initial implementation was developed with AI assistance. Review the simulator and evaluator separately, reproduce a failing trace, and explain why the corrected client's recovery is justified before relying on a result. Stateful tool evaluation has prior art, including [ToolSandbox](https://github.com/apple-aiml-research/ToolSandbox); the official [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) also supports protocol testing. Rift focuses on a small set of calendar side-effect failures.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
