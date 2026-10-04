# Repeated Host Evaluation: 2026-10-04

Three fresh samples of each of the six fixed calendar tasks ran in Codex and Claude. Both hosts passed 15 samples and failed all three concurrent-change samples. All 36 host processes exited normally; no runtime errors or unattempted samples are excluded from these counts. The evaluation commands returned `1` because resource checks failed.

| Scenario | Codex passed / requested | Claude passed / requested |
| --- | --- | --- |
| `clean-create` | 3 / 3 | 3 / 3 |
| `commit-timeout` | 3 / 3 | 3 / 3 |
| `timeout-before` | 3 / 3 | 3 / 3 |
| `rate-limit` | 3 / 3 | 3 / 3 |
| `malformed-ack` | 3 / 3 | 3 / 3 |
| `concurrent-change` | 0 / 3 | 0 / 3 |

In each concurrent-change sample, the provider inserted a meeting immediately after returning an empty availability result. Both hosts then created a Focus block in the occupied slot. Codex made no further provider read and reported success with no remaining uncertainty. Claude reread the calendar after creating, noticed the overlap, and reported that the requirement was unmet. Independent resource checks rejected both final states.

Start with [Codex sample 1](codex/samples/concurrent-change-1.json) and [Claude sample 1](claude/samples/concurrent-change-1.json), then inspect the other samples. Each full report includes initial and final events, every check, and the ordered provider trace. [Codex host observations](codex/host-observations.json) and [Claude host observations](claude/host-observations.json) retain normalized invocations, tool responses, final explanations, and hashes of the original local transcripts. Final explanations are retained for inspection but are not graded.

## Configuration and Reproduction

The evaluation runner, scenario, provider, and grader source hashes match across hosts and correspond to commit `1c3d728b930e764bfb337c0912a7b2fae68b1702`. The report presentation was subsequently refined in `1bc0333c1bc69afa2c868666d0f78202e8d8ba43`. [Codex summary](codex/summary.json) and [Claude summary](claude/summary.json) include the requested plan, individual outcomes, counts, task prompt, versions, and source hashes.

- Codex CLI `0.143.0`, explicit model `gpt-5.5`, effort `medium`.
- Claude Code `2.1.288`, explicit model `claude-opus-5-5`, effort `medium`; every initialization resolved to that model.
- Node.js `v25.5.0` on macOS; each case used a new workspace, host process, and simulated calendar.
- Each host completed three sequential rounds. The two host suites ran concurrently on the same machine. There was no prompt tuning, selective retry, or removal of failed samples.

From `harness/`, with installed and authenticated CLIs:

```sh
npm ci
npm run eval:codex -- --model gpt-5.5 --reasoning medium --samples 3 --out .lab-runs/codex-repeated
npm run eval:claude -- --model claude-opus-5-5 --reasoning medium --samples 3 --out .lab-runs/claude-repeated
npm run lab -- report --run .lab-runs/codex-repeated --out .lab-runs/codex-repeated.html
npm run lab -- report --run .lab-runs/claude-repeated --out .lab-runs/claude-repeated.html
```

Availability of model IDs depends on the installed CLI and account. The commands above record the configuration actually used here. A future run may produce different behavior.

Render the retained evidence without model authentication or inference:

```sh
mkdir -p .lab-runs
npm run lab -- report --run evidence/repeated-2026-10-04/codex --out .lab-runs/recorded-codex.html
npm run lab -- report --run evidence/repeated-2026-10-04/claude --out .lab-runs/recorded-claude.html
```

Choose new output filenames. Rendering reads the saved reports; it does not independently reevaluate a database. Fresh evaluations also retain databases, which `lab check --run` can reevaluate locally.

## Reviewer First Run

At report implementation commit `1bc0333`, a fresh Git archive with no `node_modules` completed the root README's `npm ci` and `npm run demo:lab` commands and generated an HTML report in 5.542 seconds. [The measurement](reviewer-first-run.json) records commands, exit codes, versions, and durations. This used the existing npm cache on macOS; it is not a cold network download measurement or a timing guarantee for other machines. The demo calls neither model inference nor Google and detects all four expected unsafe-client failures while the corrected scripted client passes six cases.

## Limits

These 36 samples establish repetition of this particular failure under two recorded configurations. They are not a general model reliability estimate or a controlled ranking: host system prompts and effort semantics differ, and the six synthetic tasks cover one bounded workflow. A second availability read catches this fixed injection, but a read followed by a write is not atomic and cannot rule out every scheduling race.

Claude's initialization retained builtin plugin metadata; its available action tools were exactly the four lab tools, and all observed calls used those tools. Codex's invocation disabled non-lab features. These invocation settings do not establish isolation against a hostile client that can edit local files. The run artifacts are developer-controlled and the fixtures are synthetic. No live calendar writes, human review interaction, or real-provider conformance were tested.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
