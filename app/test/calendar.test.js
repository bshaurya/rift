const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { CalendarGate, parseModel, validate } = require('../src/calendar/gate');
const { MemoryJournal, FileJournal } = require('../src/calendar/journal');
const { sample, fakeModel, FakeCalendar } = require('../demo/fakes');
function setup(options = {}) {
  const calendar = new FakeCalendar(); const store = new MemoryJournal();
  return { calendar, store, gate: new CalendarGate({ model: fakeModel, calendar, store, ...options }) };
}
test('strict model schema rejects malformed, wrapped, missing and extra fields', () => {
  for (const text of ['{', '```json\n' + JSON.stringify(sample) + '\n```', JSON.stringify({ ...sample, extra: 1 }), JSON.stringify({ title: 'Meeting' }), 'null']) assert.throws(() => parseModel(text));
  assert.deepEqual(parseModel(JSON.stringify(sample)), sample);
});
test('ambiguity, recurrence, attendees, invalid dates and timezone offsets are rejected', () => {
  for (const change of [{ ambiguities: ['Which day?'] }, { recurrence: ['RRULE:FREQ=DAILY'] }, { attendees: ['a@example.org'] }, { timeZone: 'bad' }, { start: '2026-02-30T14:00:00-05:00' }, { start: '2026-10-05T14:00:00' }, { end: sample.start }, { end: '2026-10-05T13:00:00-04:00' }, { start: '2026-10-05T14:00:00-05:00' }, { start: '2026-03-08T02:30:00-05:00' }]) assert.throws(() => validate({ ...sample, ...change }));
  assert.doesNotThrow(() => validate({ ...sample, start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T01:30:00-05:00' }));
});
test('propose does not write; cancellation is terminal', async () => {
  const { gate, calendar } = setup(); const p = await gate.propose('Request');
  assert.equal(calendar.calls.length, 0);
  gate.cancel(p.operationId, p.digest);
  assert.equal((await gate.confirm(p.operationId, p.digest)).status, 'cancelled');
  assert.equal(calendar.calls.length, 0);
});
test('altered snapshots cannot alter execution; altered digest and unknown IDs fail', async () => {
  const { gate, calendar } = setup(); const p = await gate.propose('Request');
  p.action.title = 'Tampered';
  await assert.rejects(gate.confirm(p.operationId, 'wrong'));
  await assert.rejects(gate.confirm('unknown', p.digest));
  await gate.confirm(p.operationId, p.digest);
  assert.equal(calendar.calls[0].action.title, sample.title);
});
test('stale proposals never write', async () => {
  let now = 0; const { gate, calendar } = setup({ now: () => now }); const p = await gate.propose('Request');
  now = p.expiresAt;
  assert.equal((await gate.confirm(p.operationId, p.digest)).status, 'stale');
  assert.equal(calendar.calls.length, 0);
});
test('concurrent and repeated confirmation issue one write', async () => {
  const { gate, calendar } = setup(); calendar.delayMs = 15; const p = await gate.propose('Request');
  await Promise.all(Array.from({ length: 10 }, () => gate.confirm(p.operationId, p.digest)));
  assert.equal((await gate.confirm(p.operationId, p.digest)).status, 'succeeded');
  assert.equal(calendar.calls.length, 1);
});
for (const [code, status, reason] of [[400, 'failed', 'provider-rejected'], [401, 'failed', 'auth'], [403, 'failed', 'auth'], [429, 'failed', 'rate-limit'], [500, 'uncertain'], ['ECONNRESET', 'uncertain']]) {
  test(`provider ${code} records ${status} without retry`, async () => {
    const { gate, calendar } = setup(); calendar.error = Object.assign(new Error('secret-bearing details'), { code });
    const p = await gate.propose('Request'); const result = await gate.confirm(p.operationId, p.digest);
    assert.equal(result.status, status); if (reason) assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes('secret-bearing'));
    await gate.confirm(p.operationId, p.digest); assert.equal(calendar.calls.length, 1);
  });
}
test('timeout and late completion remain uncertain across restart without retry', async () => {
  const { gate, calendar, store } = setup({ timeoutMs: 5 }); calendar.delayMs = 20;
  const p = await gate.propose('Request'); assert.equal((await gate.confirm(p.operationId, p.digest)).status, 'uncertain');
  await new Promise(resolve => setTimeout(resolve, 25));
  const next = new CalendarGate({ model: fakeModel, calendar, store });
  assert.equal((await next.confirm(p.operationId, p.digest)).status, 'uncertain'); assert.equal(calendar.calls.length, 1);
});
test('restart invalidates reviews and preserves interrupted execution as uncertain', async () => {
  const { gate, store, calendar } = setup(); const p = await gate.propose('Request');
  const next = new CalendarGate({ model: fakeModel, calendar, store });
  assert.equal((await next.confirm(p.operationId, p.digest)).status, 'stale');
  const records = store.load(); records[p.operationId].status = 'executing'; store.save(records);
  const restarted = new CalendarGate({ model: fakeModel, calendar, store });
  assert.equal(restarted.get(p.operationId).status, 'uncertain'); assert.equal(calendar.calls.length, 0);
});
test('file journal persists outcomes and corrupt storage fails closed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-test-'));
  try {
    const store = new FileJournal(path.join(directory, 'journal.json'));
    const calendar = new FakeCalendar(); const gate = new CalendarGate({ model: fakeModel, calendar, store });
    const p = await gate.propose('Request'); await gate.confirm(p.operationId, p.digest);
    assert.equal(new CalendarGate({ model: fakeModel, calendar, store }).get(p.operationId).status, 'succeeded');
    fs.writeFileSync(store.filename, '{'); assert.throws(() => new CalendarGate({ model: fakeModel, calendar, store }));
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('journal write failure prevents provider execution', async () => {
  const { gate, calendar } = setup(); const p = await gate.propose('Request');
  gate.store.save = () => { throw new Error('disk unavailable'); };
  await assert.rejects(gate.confirm(p.operationId, p.digest)); assert.equal(calendar.calls.length, 0);
});
// Execute legacy provider modules with credential-free imports; any provider use fails the test.
function legacyModule(relative) {
  const filename = path.join(__dirname, '../src', relative);
  const module = { exports: {} };
  const requireFake = id => {
    if (id === 'dotenv') return { config() {} };
    if (id === 'os') return os;
    if (id === 'axios') return {};
    if (id === 'googleapis') return { google: new Proxy({}, { get() { throw new Error('Provider reached'); } }) };
    return {};
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: requireFake, module, process: { env: {} }, console });
  return module.exports;
}
test('legacy creates, deletes, modifiers and Meet writes reject before provider access', async () => {
  const calendar = legacyModule('calendar/google.js');
  await assert.rejects(calendar.createEvent(sample), /reviewed proposal/);
  await assert.rejects(calendar.deleteEvent('candidate'), /candidate selection/);
  const modifier = legacyModule('calendar/calendarModifier.js');
  await assert.rejects(modifier.handleEventModification('change event', {}), /blocked/);
  const meet = legacyModule('meet/google.js');
  for (const fn of ['createMeeting', 'updateMeeting', 'addAttendeesToMeeting']) await assert.rejects(meet[fn]('event', {}), /blocked/);
});
test('packaging excludes environment files and alternate IPC routes through proposal service', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('!**/.env')); assert.ok(pkg.build.files.includes('!**/.env.*')); assert.ok(!pkg.build.extraResources);
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /handle\('parse-and-create-event', async \(_event, input\) => getCalendarService\(\).propose\(input\)/);
  assert.match(main, /intent === 'CALENDAR_CREATE'\) return await getCalendarService\(\).propose\(prompt\)/);
  assert.match(main, /\['CALENDAR_AND_DOCS', 'MEET_AND_EMAIL', 'CUSTOM'\]/);
});
