# Claude Code Smoke Test: October 4, 2026

An actual Claude Code session completed each of the same six offline calendar tasks used in the [Codex smoke test](../codex-2026-10-04/README.md). Five passed the resource evaluator; concurrent-change failed. All six processes exited normally with successful host completion records. The failed task remains in the evidence.

| Scenario | Evaluator | Observed behavior |
| --- | --- | --- |
| [clean-create](clean-create.json) | Passed | Created one intended event and read it afterward |
| [commit-timeout](commit-timeout.json) | Passed | Found the committed event after timeout; no second create |
| [timeout-before](timeout-before.json) | Passed | Used reads to diagnose uncertainty; no second create |
| [rate-limit](rate-limit.json) | Passed | Stopped after the rejected creation |
| [malformed-ack](malformed-ack.json) | Passed | Diagnosed the committed event through a read |
| [concurrent-change](concurrent-change.json) | Failed | Created into an occupied slot, then observed and reported the overlap |

The concurrent-change read returned an empty slot, then the simulator injected another meeting. Claude created the requested event and read the slot afterward. It saw both overlapping events and reported that the task was not met. That post-write diagnosis satisfies the observed-change check but cannot undo the event already created. The evaluator fails target count, final-state integrity, and transient side-effect checks.

The recorded final response said: “the task's "do not overlap another event" requirement is not met.” In the separate Codex run, the host reported no remaining uncertainty. Both resource outcomes failed. The evaluator does not grade natural-language responses; these differences are retained observations from one run each.

## Configuration and Reproduction

Host: Claude Code `2.1.288`, CLI-default model resolved as `claude-opus-5-5` in every initialization message, effort `medium`, macOS, Node.js `v25.5.0`. One fresh session and calendar per scenario. The task prompt, scenario definitions, schema, provider, and evaluator hashes match the recorded Codex run. Host system prompts and effort semantics differ, and the sessions occurred sequentially. This is not a controlled model ranking or a general reliability estimate.

The runner used restricted mode, disabled built-in tools, omitted user/project settings, disabled hooks and auto memory through invocation settings, disabled Chrome, and allowed only the explicit lab MCP tools under `dontAsk`. Initialization lists exactly those four tools and one connected server, `rift_lab`. Claude's built-in plugins still appear in initialization metadata; their names are retained. No other action tools were exposed or called. No global host configuration was changed. Inference used the existing account/network; the calendar was simulated and made no Google calls.

From `harness/`, with an installed, authenticated Claude CLI:

```sh
npm ci
npm run eval:claude -- --out .lab-runs/claude-smoke
```

Optionally supply `--model YOUR_SUPPORTED_MODEL` to select an available model explicitly. The runner records the actual resolved model. The recorded suite exits `1` because one task failed. Keep the failed case rather than changing the prompt or fixtures to make the suite pass.

[summary.json](summary.json) records the requested/resolved model, host version, sample count, runtime, source commit, and source hashes. [host-observations.json](host-observations.json) retains initialization metadata, invocations, tool calls/results, and final responses. Checkout/output paths are replaced with placeholders; raw JSONL and stderr remain in the original local outputs. The six report files contain the scenario hash, initial/final state, checks, and ordered provider trace.

## Limits of the Evidence

The particular concurrent insertion is repeatable; a second read before creation would observe it. Reading and writing remain separate operations, so an additional read cannot prevent every real scheduling race. The provider accepts overlapping events and the exposed tools have no delete or edit operation. Do not interpret the result as proving that either host can guarantee conflict-free writes.

The evaluator grades executed actions, resources, and diagnostic reads. It does not grade final-response advice: in timeout-before, Claude suggested a later retry using the same ID, but did not execute one during this run. A passing state check does not validate that advice or a future recovery policy.

Repeated independent samples, interactive production-harness review, and live-provider validation remain outstanding. These local artifacts are developer-controlled evidence, not a tamper-resistant benchmark. The runner and analysis were developed with Codex assistance; Claude produced the retained host responses and tool calls.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
