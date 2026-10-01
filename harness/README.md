# Rift Calendar Harness

Rift gives Codex and Claude a shared calendar tool over MCP. The host handles conversation and planning; Rift reads availability, validates structured events, checks conflicts, and records execution after local review. The server has no embedded model, Gemini dependency, or Electron dependency.

This PR supplies the harness and a persistent fake calendar. Headless Google authentication and read-based reconciliation are tracked in [issue #3](https://github.com/bshaurya/rift/issues/3). The fake mode is for testing and never contacts Google.

## Install and Connect

Use Node.js 22.13 or later. Install dependencies from this directory:

```sh
npm ci
npm test
npm run demo
```

Register the checkout with either host using an absolute script path and the same absolute data directory for every client and reviewer:

```sh
codex mcp add rift -- node /absolute/path/rift/harness/src/cli.js serve --provider fake --data /absolute/path/rift-state
claude mcp add --transport stdio rift -- node /absolute/path/rift/harness/src/cli.js serve --provider fake --data /absolute/path/rift-state
```

These commands follow the official [Codex MCP configuration](https://developers.openai.com/codex/mcp) and [Claude Code MCP setup](https://code.claude.com/docs/en/mcp) documentation. The project is a local MCP integration, not a published marketplace plugin. No host configuration is modified by installation or tests.

Ask your host:

> Use Rift to check my calendar on October 5, 2026, from 1–4pm America/New_York. Find a free 30-minute slot and propose a focus block. Show the exact event and wait for my local review.

Fake mode has an existing meeting from 1–2pm that day. A 2–2:30pm event is available. The host must supply explicit RFC3339 timestamps with offsets and the IANA timezone; suggestions return UTC instants that it should convert for display.

## Local Review

Proposals do not create events. After reading the proposed event, open your own terminal:

```sh
node /absolute/path/rift/harness/src/cli.js pending --provider fake --data /absolute/path/rift-state
node /absolute/path/rift/harness/src/cli.js review OPERATION_ID --provider fake --data /absolute/path/rift-state
```

Review prints the full stored action, destination, fingerprint, status, and expiry. Type `approve OPERATION_ID` exactly to write, `cancel` to discard, or press Enter to leave pending. Approval requires an interactive terminal; piped input is rejected. The host can then call `rift_operation` to read the actual outcome.

There is no MCP confirmation tool. This separates normal agent tool usage from local review, but it is not a security boundary against an agent or program with arbitrary shell access to your account, database, or pseudo-terminal. Give the host the intended tools and do not ask it to impersonate your review.

## Tools

| Tool | Use |
| --- | --- |
| `rift_events` | Read events in a window of at most 31 days |
| `rift_availability` | Read free windows and suggest a slot lasting 5–480 minutes |
| `rift_propose_event` | Validate and persist one conflict-free event for review |
| `rift_pending` | List up to 50 pending, executing, or uncertain operations |
| `rift_operation` | Read an operation's recorded status |
| `rift_cancel` | Cancel a proposal before execution |
| `rift_reconcile` | Read the provider by event ID after an uncertain outcome |

The event schema matches the [calendar gate](../docs/calendar-reliability.md). It excludes attendees, recurrence, all-day events, and Meet creation. Event text returned by providers is untrusted data, never instructions.

## Reliability and Limits

SQLite stores operations and uses an atomic claim before execution. Multiple MCP hosts and separate review processes can use one profile. A profile is bound to its provider/account identity; changing accounts requires a separate state directory. Reviewed proposals survive client reconnections for ten minutes. Abandoned execution becomes uncertain after its stored deadline. Provider failure details are not returned to the model.

Exact proposals with an active or succeeded action fingerprint are reused rather than inserted again, including after uncertain outcomes. Cancelled, failed, and stale proposals can be replaced. Conflict checks run before proposal and again before insertion; Google Calendar cannot make that check and insertion one atomic transaction, so another client may still book the slot in between.

The database and fake calendar contain private event data and use restricted file permissions. Keep the state directory outside repositories and shared folders. Back up or remove it only after reviewing uncertain operations. SQLite is a built-in Node feature and may emit an experimental warning on stderr in supported Node versions; stdout is reserved for MCP messages.

The scripted demo runs a real MCP client and server, finds availability, persists a proposal, simulates local approval against the fake calendar, and verifies a succeeded outcome and duplicate reuse. It does not demonstrate human approval or live Google access. Tests cover real protocol calls, schema rejection, piped review rejection, conflicts, cancellation, expiry, profile isolation, reopen/recovery, timeout reconciliation, and simultaneous reviewer processes. Actual Codex/Claude sessions and live calendar access remain unverified.

## Authorship

Rift's original application belongs to its repository contributors. This harness, tests, and documentation were developed with Codex AI assistance. The existing Electron application remains available in `app/`.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
