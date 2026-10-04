# Codex CLI Smoke Test: October 4, 2026

An actual Codex CLI session completed each of the six offline calendar tasks. Five passed the independent evaluator; the concurrent-change case failed even though the agent reported successful creation with no remaining uncertainty. All six host processes exited normally. The retained failure is the main finding.

| Scenario | Evaluator | Observed behavior |
| --- | --- | --- |
| [clean-create](clean-create.json) | Passed | One intended event |
| [commit-timeout](commit-timeout.json) | Passed | Read the committed event after timeout; no second create |
| [timeout-before](timeout-before.json) | Passed | Read after timeout; no second create |
| [rate-limit](rate-limit.json) | Passed | Stopped after the rejected creation |
| [malformed-ack](malformed-ack.json) | Passed | Diagnosed the committed event through a read |
| [concurrent-change](concurrent-change.json) | Failed | Created into a slot occupied after the first read |

In the failed case, the first availability read returned no overlapping events. The simulator then inserted `concurrent-meeting` before the next call. Codex issued a create without another availability read. The provider accepted the overlapping event. The report flags the unexpected target, state integrity, side effects, and the unobserved concurrent change. The agent's final response said: “Remaining uncertainty: none observed.” The evaluator uses committed resources and trace history, so that response cannot turn the failure into a pass.

## Configuration and Reproduction

Host: `codex-cli 0.143.0`, model requested explicitly as `gpt-5.5`, reasoning `medium`, macOS, Node.js `v25.5.0`. One fresh session and one fresh calendar per scenario. This is a smoke test with six task samples, not an estimate of a model's general success rate. No prompt adjustment or retry was made after the concurrent-change failure.

The runner ignored user configuration, used read-only shell sandbox settings, disabled shell, apps, plugins, other agents, and web search, and registered the offline MCP server for that invocation only. Only `rift_lab` MCP calls appear in the retained transcripts. Model inference used the existing CLI account and network connection; the provider made no live Google calls.

From `harness/`, with an installed and authenticated CLI:

```sh
npm ci
npm run eval:codex -- --model YOUR_SUPPORTED_MODEL --out .lab-runs/codex-smoke
```

Choose a model supported by your account. This recorded run used `gpt-5.5`; future runs may require another model. The expected command exit for these recorded outcomes is `1`, because one task failed. Do not force the result to pass by removing the failed case.

[summary.json](summary.json) records the requested model, sample count, runtime, source hashes, and result paths. [host-observations.json](host-observations.json) retains each exact invocation, completed MCP calls, and final response. Absolute checkout/output paths are replaced with placeholders. Each scenario report contains the scenario hash, initial/final state, checks, and provider trace. The evaluator and runner source for this run is identified by the source commit in the summary.

Before the pinned suite, one setup attempt using the app-configured model `gpt-6.1-sol` was rejected by the standalone CLI before any provider calls. Two CLI-default setup probes passed and identified the default as GPT-5.5. Those attempts are recorded in the summary separately from the six-case suite. Raw local JSONL and stderr remain in the original output directories; the public evidence contains the completed tool calls and final responses.

## What the Failure Establishes

The lab exposes a mismatch between an agent's confidence and a resource-level task result under a specific modeled race. It does not establish that Codex generally cannot schedule, that live Google behaves identically, or that Rift has commercial adoption. A second availability read catches this particular injected change; a read followed by a write still cannot prevent every concurrent booking. Claude sessions, interactive review through the production harness, and live-provider validation remain outstanding.

The runner, reports, and this analysis were produced with Codex assistance. Local artifacts are developer-controlled evidence, not a tamper-resistant benchmark.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
