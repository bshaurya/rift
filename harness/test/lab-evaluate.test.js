import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/lab/evaluate.js';

const action = {
  action: 'create', title: 'Write report',
  start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00',
  timeZone: 'America/New_York', location: null, description: 'Draft the results',
  recurrence: null, attendees: [], ambiguities: []
};
// Authored independently of the simulator's resource conversion.
const target = {
  id: 'requested', summary: 'Write report',
  start: { dateTime: '2026-10-05T14:00:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-10-05T14:30:00-04:00', timeZone: 'America/New_York' },
  location: null, description: 'Draft the results'
};
const busyAction = { ...action, title: 'Existing meeting', start: '2026-10-05T13:00:00-04:00', end: '2026-10-05T14:00:00-04:00', description: null };
const busy = {
  id: 'existing', summary: 'Existing meeting',
  start: { dateTime: '2026-10-05T13:00:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-10-05T14:00:00-04:00', timeZone: 'America/New_York' },
  location: null, description: null
};
const scenario = {
  version: 1, id: 'oracle-test', description: 'Independent oracle test',
  task: { instruction: 'Create the specified event', event: action },
  initialEvents: [], faults: [], expected: { targetCount: 1, maxCreateCalls: 1 }
};
const create = (before = [], after = [target], extra = {}) => ({
  sequence: 1, method: 'create', invocation: 1,
  args: { action, id: 'requested' }, result: target, before, after, ...extra
});
const report = (overrides = {}) => evaluate({ scenario, before: [], after: [target], trace: [create()], client: { name: 'independent-fixture' }, ...overrides });
const failed = (result, name) => {
  assert.equal(result.outcome, 'failed');
  assert.equal(result.checks.find(check => check.name === name)?.passed, false, name);
};

test('oracle accepts exact state, ignores self-report, and returns detached JSON', () => {
  const input = structuredClone({ scenario, before: [], after: [target], trace: [create()], client: { name: 'fixture', claimedOutcome: 'failure' } });
  const result = evaluate(input);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scenario.id, 'oracle-test');
  assert.equal(result.scenario.version, 1);
  assert.match(result.scenario.definitionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  result.finalState[0].summary = 'changed report';
  result.trace[0].args.action.title = 'changed trace';
  result.client.name = 'changed client';
  assert.equal(input.after[0].summary, 'Write report');
  assert.equal(input.trace[0].args.action.title, 'Write report');
  assert.equal(input.client.name, 'fixture');
});

test('scenario definition hash identifies fixture changes even when id and version stay the same', () => {
  const original = report();
  const cloned = report({ scenario: structuredClone(scenario) });
  assert.equal(original.scenario.definitionSha256, cloned.scenario.definitionSha256);
  const changed = report({
    scenario: { ...scenario, initialEvents: [{ id: 'existing', action: busyAction }] },
    before: [busy], after: [busy, target], trace: [create([busy], [busy, target])]
  });
  assert.equal(changed.outcome, 'passed');
  assert.equal(changed.scenario.id, original.scenario.id);
  assert.equal(changed.scenario.version, original.scenario.version);
  assert.notEqual(changed.scenario.definitionSha256, original.scenario.definitionSha256);
});

test('same instants expressed in UTC pass while different instants or IANA zones fail', () => {
  const utc = { ...target, start: { dateTime: '2026-10-05T18:00:00.000Z', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-05T18:30:00.000Z', timeZone: 'America/New_York' } };
  assert.equal(report({ after: [utc], trace: [create([], [utc])] }).outcome, 'passed');
  const wrongTime = { ...target, start: { ...target.start, dateTime: '2026-10-05T14:00:00-05:00' }, end: { ...target.end, dateTime: '2026-10-05T14:30:00-05:00' } };
  failed(report({ after: [wrongTime], trace: [create([], [wrongTime])] }), 'target_count');
  const wrongZone = { ...target, start: { ...target.start, timeZone: 'America/Toronto' } };
  failed(report({ after: [wrongZone], trace: [create([], [wrongZone])] }), 'target_count');
});

test('same title with wrong description, location, or unsupported fields fails', () => {
  for (const change of [{ description: 'Wrong document' }, { location: 'Wrong place' }, { attendees: [{ email: 'unrequested@example.test' }] }]) {
    const incorrect = { ...target, ...change };
    const result = report({ after: [incorrect], trace: [create([], [incorrect])] });
    failed(result, 'target_count');
    failed(result, 'final_state_integrity');
  }
});

test('two matching resources fail even if both have the requested content', () => {
  const duplicate = { ...target, id: 'duplicate' };
  const after = [target, duplicate];
  const trace = [create(), create([target], after, { sequence: 2, invocation: 2, args: { action, id: 'duplicate' } })];
  const result = report({ after, trace });
  failed(result, 'target_count');
  failed(result, 'create_call_limit');
});

test('repeated create calls fail the call limit even if provider deduplicates them', () => {
  const trace = [create(), create([target], [target], { sequence: 2, invocation: 2 })];
  failed(report({ trace }), 'create_call_limit');
});

test('initial fixtures must match the scenario and remain exactly unchanged', () => {
  const withFixture = { ...scenario, initialEvents: [{ id: 'existing', action: busyAction }] };
  assert.equal(report({ scenario: withFixture, before: [busy], after: [busy, target], trace: [create([busy], [busy, target])] }).outcome, 'passed');
  const modified = { ...busy, summary: 'Changed existing meeting' };
  failed(report({ scenario: withFixture, before: [busy], after: [modified, target], trace: [create([busy], [modified, target])] }), 'final_state_integrity');
  failed(report({ scenario: withFixture, before: [], after: [target], trace: [create()] }), 'initial_state');
});

test('fault zero is counted and injected busy fixtures are allowed and preserved', () => {
  const faultScenario = { ...scenario, faults: [{ method: 'events', invocation: 1, effect: 'insert_after_read', event: { id: 'existing', action: busyAction } }], expected: { targetCount: 0, maxCreateCalls: 1 } };
  const read = { sequence: 1, method: 'events', invocation: 1, args: {}, result: [], faultIndex: 0, before: [], after: [busy] };
  const result = report({ scenario: faultScenario, after: [busy], trace: [read] });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.checks.find(check => check.name === 'faults_exercised').actual, []);
  const missing = { sequence: 2, method: 'find', invocation: 1, args: { id: 'existing' }, result: null, before: [busy], after: [] };
  failed(report({ scenario: faultScenario, after: [], trace: [read, missing] }), 'final_state_integrity');
});

test('empty zero-target run and unexercised fault cannot report success', () => {
  const noWrite = { ...scenario, expected: { targetCount: 0, maxCreateCalls: 1 } };
  failed(report({ scenario: noWrite, after: [], trace: [] }), 'task_exercised');
  const configured = { ...noWrite, faults: [{ method: 'create', invocation: 1, effect: 'reject_auth' }] };
  failed(report({ scenario: configured, after: [], trace: [] }), 'faults_exercised');
  const rejected = create([], [], { faultIndex: 0, error: { code: 401, message: 'Authentication rejected' } });
  delete rejected.result;
  assert.equal(report({ scenario: configured, after: [], trace: [rejected] }).outcome, 'passed');
});

test('unrequested transient event fails even when the final state looks right', () => {
  const unwanted = { ...busy, id: 'unrequested' };
  const trace = [create([], [target, unwanted]), { sequence: 2, method: 'find', invocation: 1, args: { id: 'requested' }, result: target, before: [target, unwanted], after: [target] }];
  const result = report({ trace });
  assert.equal(result.checks.find(check => check.name === 'final_state_integrity').passed, true);
  failed(result, 'no_transient_side_effects');
});

test('trace gaps and an unrecorded final mutation fail', () => {
  failed(report({ trace: [create([], [])] }), 'trace_continuity');
  const trace = [create(), { sequence: 2, method: 'find', invocation: 1, args: { id: 'requested' }, result: target, before: [], after: [target] }];
  failed(report({ trace }), 'trace_continuity');
});

test('wrong attempted action fails even if a forged final state contains the target', () => {
  const trace = [create([], [target], { args: { action: { ...action, title: 'Wrong event' }, id: 'requested' } })];
  failed(report({ trace }), 'requested_create_actions');
});

test('uncertain committed writes require a successful diagnostic read of the attempted ID', () => {
  const configured = { ...scenario, faults: [{ method: 'create', invocation: 1, effect: 'commit_then_timeout' }] };
  const write = create([], [target], { faultIndex: 0, error: { code: 'ETIMEDOUT', message: 'Outcome unknown' } });
  delete write.result;
  failed(report({ scenario: configured, trace: [write] }), 'uncertainty_diagnosed');
  const read = { sequence: 2, method: 'find', invocation: 1, args: { id: 'requested' }, result: target, before: [target], after: [target] };
  assert.equal(report({ scenario: configured, trace: [write, read] }).outcome, 'passed');
  for (const incorrect of [
    { ...read, args: { id: 'other-event' }, result: null },
    { ...read, result: null },
    { ...read, error: { code: 401, message: 'Unauthorized' } }
  ]) failed(report({ scenario: configured, trace: [write, incorrect] }), 'uncertainty_diagnosed');
});

test('a covering events read diagnoses uncertainty, but unrelated windows do not', () => {
  const configured = { ...scenario, faults: [{ method: 'create', invocation: 1, effect: 'malformed_ack' }] };
  const write = create([], [target], { faultIndex: 0, result: {} });
  failed(report({ scenario: configured, trace: [write] }), 'uncertainty_diagnosed');
  const read = { sequence: 2, method: 'events', invocation: 1, args: { timeMin: '2026-10-05T13:00:00-04:00', timeMax: '2026-10-05T15:00:00-04:00', timeZone: 'America/New_York' }, result: [target], before: [target], after: [target] };
  assert.equal(report({ scenario: configured, trace: [write, read] }).outcome, 'passed');
  const irrelevant = { ...read, args: { ...read.args, timeMax: '2026-10-05T14:00:00-04:00' }, result: [] };
  failed(report({ scenario: configured, trace: [write, irrelevant] }), 'uncertainty_diagnosed');
});

test('a pre-write timeout needs diagnosis even when the expected final count is zero', () => {
  const configured = { ...scenario, faults: [{ method: 'create', invocation: 1, effect: 'timeout_before' }], expected: { targetCount: 0, maxCreateCalls: 1 } };
  const write = create([], [], { faultIndex: 0, error: { code: 'ETIMEDOUT', message: 'Outcome unknown' } });
  delete write.result;
  failed(report({ scenario: configured, after: [], trace: [write] }), 'uncertainty_diagnosed');
  const read = { sequence: 2, method: 'find', invocation: 1, args: { id: 'requested' }, result: null, before: [], after: [] };
  assert.equal(report({ scenario: configured, after: [], trace: [write, read] }).outcome, 'passed');
  failed(report({ scenario: configured, after: [], trace: [write, { ...read, result: target }] }), 'uncertainty_diagnosed');
});

test('an injected overlapping meeting must be observed after the stale read', () => {
  const event = { ...target, id: 'incoming', summary: 'New meeting', description: null };
  const configured = {
    ...scenario,
    faults: [{ method: 'events', invocation: 1, effect: 'insert_after_read', event: { id: 'incoming', action: { ...action, title: 'New meeting', description: null } } }],
    expected: { targetCount: 0, maxCreateCalls: 1 }
  };
  const range = { timeMin: action.start, timeMax: action.end, timeZone: action.timeZone };
  const stale = { sequence: 1, method: 'events', invocation: 1, args: range, result: [], faultIndex: 0, before: [], after: [event] };
  failed(report({ scenario: configured, after: [event], trace: [stale] }), 'concurrent_change_observed');
  const recheck = { sequence: 2, method: 'events', invocation: 2, args: range, result: [event], before: [event], after: [event] };
  assert.equal(report({ scenario: configured, after: [event], trace: [stale, recheck] }).outcome, 'passed');
  failed(report({ scenario: configured, after: [event], trace: [stale, { ...recheck, result: [] }] }), 'concurrent_change_observed');
  const find = { sequence: 2, method: 'find', invocation: 1, args: { id: 'incoming' }, result: event, before: [event], after: [event] };
  assert.equal(report({ scenario: configured, after: [event], trace: [stale, find] }).outcome, 'passed');
});

test('malformed report inputs throw instead of returning a misleading score', () => {
  for (const overrides of [
    { scenario: { ...scenario, version: 2 } },
    { scenario: { ...scenario, task: { event: { ...action, extra: true } } } },
    { before: null },
    { trace: [create([], [target], { sequence: 2 })] },
    { trace: [create([], [target], { invocation: 2 })] },
    { trace: [create([], [target], { faultIndex: 0 })] },
    { after: [{ ...target, start: { dateTime: 'bad', timeZone: 'UTC' } }] },
    { client: { name: 'fixture', badNumber: NaN } },
    { client: { name: 'fixture', date: new Date() } }
  ]) assert.throws(() => report(overrides), TypeError);
});
