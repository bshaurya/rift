const { CalendarGate } = require('../src/calendar/gate');
const { MemoryJournal } = require('../src/calendar/journal');
const { fakeModel, FakeCalendar } = require('./fakes');

(async () => {
  const calendar = new FakeCalendar();
  const store = new MemoryJournal();
  const gate = new CalendarGate({ model: fakeModel, calendar, store, timeoutMs: 10 });
  const proposal = await gate.propose('Create Rift Review, October 5, 2026, 2–2:30pm America/New_York');
  console.log('REVIEW (no writes yet)', JSON.stringify(proposal, null, 2));
  await Promise.all([gate.confirm(proposal.operationId, proposal.digest), gate.confirm(proposal.operationId, proposal.digest)]);
  console.log('CONFIRMED:', gate.get(proposal.operationId).status, '| provider writes:', calendar.calls.length);
  const cancelled = await gate.propose('Same request');
  gate.cancel(cancelled.operationId, cancelled.digest);
  await gate.confirm(cancelled.operationId, cancelled.digest);
  console.log('CANCELLED:', gate.get(cancelled.operationId).status, '| provider writes:', calendar.calls.length);
  calendar.delayMs = 30;
  const uncertain = await gate.propose('Same request');
  await gate.confirm(uncertain.operationId, uncertain.digest);
  console.log('TIMEOUT:', gate.get(uncertain.operationId).status);
  const restarted = new CalendarGate({ model: fakeModel, calendar, store });
  await restarted.confirm(uncertain.operationId, uncertain.digest);
  console.log('RESTART: no retry | provider writes:', calendar.calls.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
