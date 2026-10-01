# Calendar Reliability

Rift proposes one nonrecurring event in the primary calendar. Creation follows request → proposal → deterministic validation → review → confirm or cancel → execution → recorded outcome. The core in `app/src/calendar/gate.js` imports no Electron, Google, or model SDK.

## Try It

From `app/`, with Node.js 22 or later:

```sh
npm test
npm run demo:calendar
```

These commands use a fake model and calendar, require no installed dependencies or credentials, and make no network calls. The fake model returns a fixed fixture; it does not demonstrate language understanding.

For the desktop app, use `npm ci`, configure the variables listed in the root README, and run `npm start`. An explicit command beginning with “create event” reaches the proposal gate before probabilistic intent and workflow routing. For example:

> Create event Rift Review on October 5, 2026, from 2pm to 2:30pm in America/New_York.

The parser requires a supported `GEMINI_MODEL` chosen for the configured account. Review every field, then use Confirm or Cancel. Calendar authentication is checked during confirmation. Use the existing calendar sign-in control if authentication fails, then make a new proposal.

## Proposal and Outcomes

Model output must be a plain JSON object with exactly `action`, `title`, `start`, `end`, `timeZone`, `location`, `description`, `recurrence`, `attendees`, and `ambiguities`. The only action is `create`. Recurrence must be null, attendees and ambiguities must be empty arrays, and missing optional text fields must be null. Required dates include seconds and explicit offsets. The named IANA timezone must agree with both timestamps, including daylight saving time. End must follow start. Invalid dates, wrapped JSON, extra fields, unsupported writes, and missing information are rejected.

Each proposal has a UUID operation ID, an action fingerprint, and a ten-minute review window. Confirm and Cancel send only that ID and fingerprint; the main process executes its stored validated action. Copies returned to the renderer cannot edit that action. Model text in the review uses DOM text content.

The journal at Electron's user-data `calendar-operations.json` records event details and outcomes, with restricted file permissions and atomic replacement. It contains personal calendar data and should not be shared. A failed journal load or write blocks execution. Only one Electron application instance can own the journal.

| Status | Meaning |
| --- | --- |
| proposed | Validated, awaiting explicit review |
| cancelled | Cancelled before execution; confirmation cannot write |
| stale | Review expired or the application restarted; make a fresh proposal |
| executing | Persisted before calling the provider |
| succeeded | Provider acknowledged creation; event ID recorded |
| failed | Authentication failed before insertion or the provider explicitly rejected the write |
| uncertain | Timeout, interrupted execution, connection failure, or unclassified provider failure; the event may exist |

Repeated and concurrent confirmations of one operation issue at most one adapter call. Google insertion uses the operation ID as the event ID and disables transport retries. No terminal operation is automatically retried. A timeout can occur while the provider continues processing. Inspect the primary calendar before creating another proposal; the application does not yet reconcile uncertain results through provider reads. On restart, pending reviews become stale and interrupted execution becomes uncertain. The renderer displays the latest stale or uncertain record; `calendarOutcomes` exposes the complete journal through the preload API.

## Write Boundaries

Both `route-prompt` and `parse-and-create-event` produce proposals. Confirm and Cancel have dedicated IPC handlers. Legacy calendar create/delete helpers reject writes. Modification helpers, Google Meet create/update/attendee helpers, and calendar/custom workflows are blocked before their write calls. Deletion has no substring fallback in the main process. A future deletion slice must list candidates and require an explicit event selection followed by review; it cannot reuse an inferred title match.

## Verified Results and Limits

On October 1, 2026, local Node.js tests passed for strict schema handling, ambiguity, unsupported recurrence/attendees, date ordering and timezone validation, cancellation, altered/stale proposals, concurrent confirmation, auth/rate-limit/provider/transport failures, timeout and late completion, restart recovery, file persistence and journal failures, legacy write rejection, actual IPC registration, Google adapter options, and renderer review behavior. The credential-free demo completed successfully. CI runs the same tests and demo on Node.js 22 without installing Electron dependencies.

Live Google Calendar and Gemini calls, full Electron UI launch, native dependency installation, and release packaging were not tested. The legacy intent/workflow model endpoints remain outside this slice; the explicit “create event” route avoids them. Schema checks cannot prove that a model correctly interpreted the user's words, so review remains necessary. Separate proposals are separate operations and may intentionally create similar events. The journal assumes one process and an ordinary local filesystem, and has no cross-device synchronization, retention policy, or provider reconciliation. Supported creation excludes all-day events, recurrence, attendees, and Meet conferencing.

## 75-Second Demo

1. **0–15 seconds:** Run `npm run demo:calendar`. Point to the proposed title, explicit offsets, timezone, operation ID, and zero writes before confirmation.
2. **15–30 seconds:** Explain that the demo submits two concurrent confirmations. Both refer to the same reviewed operation, and the provider receives one write.
3. **30–45 seconds:** Show cancellation. A subsequent confirmation produces no additional provider call.
4. **45–60 seconds:** Show timeout becoming uncertain. Explain that the event may already exist and the app does not blindly retry it.
5. **60–75 seconds:** Show restart preserving uncertainty, then run `npm test`. Note that these adapters use no credentials and that live integration remains unverified.

## Authorship

The existing Rift application is the work of its repository contributors, including bshaurya. This local calendar reliability slice, tests, fake demo, CI workflow, and documentation were generated with Codex AI assistance and require maintainer review. No commit, push, publication, live calendar mutation, or email send was performed during implementation.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
