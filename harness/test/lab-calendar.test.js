import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ScenarioCalendar, LAB_DATABASE } from '../src/lab/calendar.js';
import { scenarioSchema } from '../src/lab/schema.js';

const action = {
  action: 'create', title: 'Write the report', start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00',
  timeZone: 'America/New_York', location: null, description: null, recurrence: null, attendees: [], ambiguities: []
};
const range = { timeMin: action.start, timeMax: '2026-10-05T16:00:00-04:00', timeZone: action.timeZone };
const scenario = (faults = [], initialEvents = []) => ({
  version: 1, id: 'calendar-test', description: 'A deterministic calendar scenario.',
  task: { instruction: 'Schedule one report writing block.', event: structuredClone(action) },
  initialEvents, faults, expected: { targetCount: 1, maxCreateCalls: 1 }
});
function fixture(t, value = scenario()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-lab-calendar-'));
  ScenarioCalendar.initialize(directory, value);
  const calendar = new ScenarioCalendar(directory);
  t.after(() => { calendar.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, calendar };
}
const catches = async promise => {
  try { await promise; assert.fail('Expected a provider error.'); }
  catch (error) { return error; }
};

test('scenario schema rejects malformed actions, extra fields and ambiguous fault rules', () => {
  const mutations = [
    value => { value.extra = true; },
    value => { value.task.event.extra = true; },
    value => { value.task.event.start = '2026-02-30T14:00:00-05:00'; },
    value => { value.task.event.end = value.task.event.start; },
    value => { value.task.event.timeZone = 'unknown/timezone'; },
    value => { value.task.event.start = '2026-10-05T14:00:00-05:00'; },
    value => { value.task.event.attendees = ['person@example.invalid']; },
    value => { value.task.event.recurrence = 'weekly'; },
    value => { value.task.event.ambiguities = ['Missing end']; },
    value => { value.description = ' '; },
    value => { value.task.instruction = ''; },
    value => { value.id = '../escape'; },
    value => { value.initialEvents = [{ id: 'same', action }, { id: 'same', action }]; },
    value => { value.faults = [{ method: 'find', invocation: 1, effect: 'commit_then_timeout' }]; },
    value => { value.faults = [{ method: 'events', invocation: 1, effect: 'malformed_ack' }]; },
    value => { value.faults = [{ method: 'events', invocation: 1, effect: 'insert_after_read' }]; },
    value => { value.faults = [{ method: 'create', invocation: 1, effect: 'insert_after_read', event: { id: 'injected', action } }]; },
    value => { value.faults = [{ method: 'create', invocation: 1, effect: 'timeout_before', event: { id: 'injected', action } }]; },
    value => { value.faults = [{ method: 'create', invocation: 0, effect: 'timeout_before' }]; },
    value => { value.faults = [{ method: 'create', invocation: 1, effect: 'timeout_before' }, { method: 'create', invocation: 1, effect: 'reject_auth' }]; },
    value => { value.initialEvents = [{ id: 'same', action }]; value.faults = [{ method: 'events', invocation: 1, effect: 'insert_after_read', event: { id: 'same', action } }]; }
  ];
  for (const mutate of mutations) {
    const value = scenario(); mutate(value);
    assert.equal(scenarioSchema.safeParse(value).success, false, mutate.toString());
  }
});

test('initialization validates before creating files and never resets an existing run', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-lab-initialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing');
  assert.throws(() => new ScenarioCalendar(missing));
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => ScenarioCalendar.initialize(missing, { ...scenario(), version: 99 }));
  assert.equal(fs.existsSync(missing), false);
  ScenarioCalendar.initialize(missing, scenario());
  const first = new ScenarioCalendar(missing);
  const identity = first.identity;
  await first.create(action, 'event-one'); first.close(); first.close();
  assert.throws(() => ScenarioCalendar.initialize(missing, scenario()), { code: 'EEXIST' });
  const reopened = new ScenarioCalendar(missing);
  try { assert.equal(reopened.identity, identity); assert.equal(reopened.snapshot().length, 1); }
  finally { reopened.close(); }
  const otherDirectory = path.join(root, 'other');
  ScenarioCalendar.initialize(otherDirectory, scenario());
  const other = new ScenarioCalendar(otherDirectory);
  try { assert.notEqual(other.identity, identity); }
  finally { other.close(); }
});

test('both timeout effects look identical to the caller but record different committed state', async t => {
  const committed = fixture(t, scenario([{ method: 'create', invocation: 1, effect: 'commit_then_timeout' }]));
  const untouched = fixture(t, scenario([{ method: 'create', invocation: 1, effect: 'timeout_before' }]));
  const first = await catches(committed.calendar.create(action, 'target'));
  const second = await catches(untouched.calendar.create(action, 'target'));
  assert.equal(first.code, 'ETIMEDOUT');
  assert.equal(first.code, second.code); assert.equal(first.message, second.message); assert.equal(first.publicMessage, second.publicMessage);
  assert.equal(first.beforeWrite, undefined); assert.equal(second.beforeWrite, undefined);
  assert.equal(committed.calendar.snapshot().length, 1); assert.equal(untouched.calendar.snapshot().length, 0);
  const trace = committed.calendar.trace();
  assert.equal(trace[0].sequence, 1); assert.equal(trace[0].invocation, 1); assert.equal(trace[0].faultIndex, 0);
  assert.deepEqual(trace[0].args, { action, id: 'target' });
  assert.deepEqual(trace[0].before, []); assert.equal(trace[0].after.length, 1);
  assert.equal(Object.hasOwn(trace[0], 'result'), false);
  assert.equal((await committed.calendar.find('target')).id, 'target');
  assert.equal(await untouched.calendar.find('target'), null);
});

test('authentication and rate limits reject without mutation and keep a trace', async t => {
  for (const [effect, code] of [['reject_auth', 401], ['reject_rate_limit', 429]]) {
    const { calendar } = fixture(t, scenario([{ method: 'create', invocation: 1, effect }]));
    assert.equal((await catches(calendar.create(action, 'target'))).code, code);
    assert.deepEqual(calendar.snapshot(), []);
    const [record] = calendar.trace();
    assert.deepEqual(record.before, record.after); assert.equal(record.error.code, code); assert.equal(record.faultIndex, 0);
    assert.equal((await calendar.create(action, 'target')).id, 'target');
    assert.equal(calendar.trace()[1].invocation, 2);
  }
});

test('malformed acknowledgement commits an event that can subsequently be read', async t => {
  const { calendar } = fixture(t, scenario([{ method: 'create', invocation: 1, effect: 'malformed_ack' }]));
  assert.deepEqual(await calendar.create(action, 'target'), {});
  assert.equal(calendar.snapshot().length, 1);
  assert.deepEqual(calendar.trace()[0].result, {});
  assert.equal((await calendar.find('target')).id, 'target');
});

test('a post-read insertion returns the old view and detached snapshots preserve history', async t => {
  const { calendar } = fixture(t, scenario([{ method: 'events', invocation: 1, effect: 'insert_after_read', event: { id: 'new-conflict', action } }]));
  assert.deepEqual(await calendar.events(range), []);
  const rows = await calendar.events(range);
  assert.equal(rows.length, 1); rows[0].summary = 'Mutated caller value';
  assert.equal(calendar.snapshot()[0].summary, action.title);
  const inspected = calendar.inspect();
  assert.deepEqual(inspected.trace[0].before, []); assert.equal(inspected.trace[0].after.length, 1);
  assert.deepEqual(inspected.trace[0].result, []);
  assert.deepEqual(inspected.trace[0].after, inspected.trace[1].before);
  inspected.events[0].summary = 'changed'; inspected.trace[0].after[0].summary = 'changed'; inspected.scenario.task.event.title = 'changed';
  assert.equal(calendar.snapshot()[0].summary, action.title);
  assert.equal(calendar.trace()[0].after[0].summary, action.title);
  assert.equal(calendar.scenario.task.event.title, action.title);
});

test('duplicate event IDs reject both identical and different payloads', async t => {
  const { calendar } = fixture(t);
  await calendar.create(action, 'target');
  assert.equal((await catches(calendar.create(action, 'target'))).code, 409);
  assert.equal((await catches(calendar.create({ ...action, title: 'Changed title' }, 'target'))).code, 409);
  assert.equal(calendar.snapshot().length, 1); assert.equal(calendar.snapshot()[0].summary, action.title);
  const trace = calendar.trace();
  assert.deepEqual(trace.map(record => record.invocation), [1, 2, 3]);
  assert.deepEqual(trace[1].before, trace[1].after); assert.deepEqual(trace[2].before, trace[2].after);
});

test('reopening preserves method counts, fault consumption and trace continuity', async t => {
  const { calendar, directory } = fixture(t, scenario([{ method: 'create', invocation: 1, effect: 'commit_then_timeout' }]));
  assert.equal((await catches(calendar.create(action, 'first'))).code, 'ETIMEDOUT');
  calendar.close();
  const reopened = new ScenarioCalendar(directory);
  try {
    assert.equal((await reopened.find('first')).id, 'first');
    assert.equal((await reopened.create(action, 'second')).id, 'second');
    const trace = reopened.trace();
    assert.deepEqual(trace.map(record => record.sequence), [1, 2, 3]);
    assert.deepEqual(trace.map(record => record.invocation), [1, 1, 2]);
    assert.equal(Object.hasOwn(trace[2], 'faultIndex'), false);
    assert.equal(reopened.snapshot().length, 2);
  } finally { reopened.close(); }
});

test('a trace persistence failure rolls back events, counters and fault consumption together', async t => {
  const { calendar, directory } = fixture(t, scenario([{ method: 'create', invocation: 1, effect: 'commit_then_timeout' }]));
  const admin = new DatabaseSync(path.join(directory, LAB_DATABASE));
  try {
    admin.exec("CREATE TRIGGER fail_trace BEFORE INSERT ON trace BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
    assert.equal((await catches(calendar.create(action, 'target'))).code, 'LAB_TRANSACTION');
    assert.deepEqual(calendar.snapshot(), []); assert.deepEqual(calendar.trace(), []);
    admin.exec('DROP TRIGGER fail_trace');
    assert.equal((await catches(calendar.create(action, 'target'))).code, 'ETIMEDOUT');
    const [record] = calendar.trace();
    assert.equal(record.sequence, 1); assert.equal(record.invocation, 1); assert.equal(record.faultIndex, 0);
    assert.equal(calendar.snapshot().length, 1);
  } finally { admin.close(); }
});

test('independent processes creating the same ID commit only one payload', async t => {
  const { calendar, directory } = fixture(t);
  const moduleURL = new URL('../src/lab/calendar.js', import.meta.url).href;
  const script = `import {ScenarioCalendar} from ${JSON.stringify(moduleURL)};
    const calendar = new ScenarioCalendar(process.argv[1]);
    try { console.log(JSON.stringify({event: await calendar.create(JSON.parse(process.argv[2]), 'shared-id')})); }
    catch (error) { console.log(JSON.stringify({code: error.code})); }
    finally { calendar.close(); }`;
  const run = value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, JSON.stringify(value)], { stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
  const results = await Promise.all([run(action), run({ ...action, title: 'Other requested title' })]);
  assert.equal(results.filter(value => value.event).length, 1); assert.equal(results.filter(value => value.code === 409).length, 1);
  assert.equal(calendar.snapshot().length, 1);
  assert.equal(calendar.snapshot()[0].summary, results.find(value => value.event).event.summary);
  assert.deepEqual(calendar.trace().map(record => record.sequence), [1, 2]);
  assert.deepEqual(calendar.trace().map(record => record.invocation), [1, 2]);
});

test('range queries use half-open intervals and busy delegates its events fault slot', async t => {
  const initialEvents = [
    { id: 'left', action: { ...action, start: '2026-10-05T13:00:00-04:00', end: action.start } },
    { id: 'inside', action },
    { id: 'right', action: { ...action, start: range.timeMax, end: '2026-10-05T17:00:00-04:00' } }
  ];
  const { calendar } = fixture(t, scenario([{ method: 'events', invocation: 1, effect: 'reject_rate_limit' }], initialEvents));
  assert.equal((await catches(calendar.events({ ...range, timeMax: range.timeMin }))).code, 400);
  assert.equal((await catches(calendar.create({ ...action, extra: true }, 'bad'))).code, 400);
  assert.deepEqual(calendar.trace(), []);
  assert.equal((await catches(calendar.busy(range))).code, 429);
  assert.deepEqual(await calendar.busy(range), [{ start: action.start, end: action.end }]);
  assert.deepEqual(calendar.trace().map(record => record.method), ['events', 'events']);
  assert.deepEqual(calendar.trace().map(record => record.invocation), [1, 2]);
  assert.deepEqual(calendar.snapshot().map(event => event.id), ['inside', 'left', 'right']);
});
