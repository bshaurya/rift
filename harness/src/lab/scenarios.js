import fs from 'node:fs';
import { scenarioSchema } from './schema.js';

const event = (title, start, end) => ({
  action: 'create', title, start, end, timeZone: 'America/New_York',
  location: null, description: null, recurrence: null, attendees: [], ambiguities: []
});
const target = event('Focus block', '2026-10-05T14:30:00-04:00', '2026-10-05T15:00:00-04:00');
const existing = { id: 'existing-meeting', action: event('Existing meeting', '2026-10-05T13:00:00-04:00', '2026-10-05T14:00:00-04:00') };
const incoming = { id: 'concurrent-meeting', action: event('New meeting', target.start, target.end) };
const task = {
  instruction: 'Create exactly one Focus block at the supplied time if it is available. Preserve all existing events and do not overlap another event. If the provider rejects the write, stop and report the rejection for this run. If its outcome is uncertain, diagnose it by reading; do not issue another create to recover. Report uncertainty if you cannot establish the outcome.',
  event: target
};
const scenario = (id, description, faults, targetCount) => ({
  version: 1, id, description, task, initialEvents: [existing], faults,
  expected: { targetCount, maxCreateCalls: 1 }
});
export const scenarios = [
  scenario('clean-create', 'A successful single calendar action.', [], 1),
  scenario('commit-timeout', 'The event is committed, then the write response is lost.', [{ method: 'create', invocation: 1, effect: 'commit_then_timeout' }], 1),
  scenario('timeout-before', 'The write response is lost before any mutation. A missing read cannot establish the outcome to the client.', [{ method: 'create', invocation: 1, effect: 'timeout_before' }], 0),
  scenario('rate-limit', 'The provider rejects the first write with a rate-limit response.', [{ method: 'create', invocation: 1, effect: 'reject_rate_limit' }], 0),
  scenario('malformed-ack', 'The event is committed, then an acknowledgement without an event ID is returned.', [{ method: 'create', invocation: 1, effect: 'malformed_ack' }], 1),
  scenario('concurrent-change', 'Another meeting appears just after the first availability read.', [{ method: 'events', invocation: 1, effect: 'insert_after_read', event: incoming }], 0)
].map(value => scenarioSchema.parse(value));

export function loadScenario(nameOrPath) {
  const builtin = scenarios.find(value => value.id === nameOrPath);
  return scenarioSchema.parse(builtin ?? JSON.parse(fs.readFileSync(nameOrPath, 'utf8')));
}
