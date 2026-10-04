# Recorded Host Evaluations

Actual Codex and Claude Code CLI sessions used the same six offline task definitions and resource evaluator. Each host had one fresh session and calendar per scenario. These are smoke tests, not model reliability estimates or a controlled ranking.

| Scenario | Codex: GPT-5.5 | Claude: Opus 5.5 |
| --- | --- | --- |
| clean-create | Passed | Passed |
| commit-timeout | Passed | Passed |
| timeout-before | Passed | Passed |
| rate-limit | Passed | Passed |
| malformed-ack | Passed | Passed |
| concurrent-change | Failed | Failed |

Both hosts created an event in a slot occupied after the first availability read. Codex reported success with no remaining uncertainty. Claude read afterward, noticed the overlap, and reported that the task was not met. The evaluator rejected both resulting states. Successful tool responses and host completion records did not determine the task outcome.

Retained evidence includes exact invocations, resolved/requested models, completed tool calls, final responses, source and scenario hashes, and passing and failing reports:

- [Codex, October 4, 2026](codex-2026-10-04/README.md): six tasks, model requested as GPT-5.5
- [Claude Code, October 4, 2026](claude-2026-10-04/README.md): six tasks, default resolved as `claude-opus-5-5`

The task prompts and core provider/evaluator source hashes match. Host system prompts, CLI versions, and effort semantics differ. The injected scheduling race is one specific case; another read catches that injection but does not make reading and insertion atomic. The evaluator grades executed actions and resources, not every recommendation in the final response.

Use the [lab runners](../LAB.md) to reproduce fresh evaluations. Keep failed cases and record individual runs before estimating reliability. All provider state here is synthetic; model inference used the host accounts and network. Live-provider and interactive production-harness validation remain outstanding.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
