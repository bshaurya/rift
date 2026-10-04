const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryJournal } = require('../src/calendar/journal');
const { sample } = require('../demo/fakes');

test('Google adapter disables retries, preserves reviewed times and uses operation ID; auth fails before insert', async () => {
  const inserts = []; let authFails = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/calendar/service.js'), 'utf8'), {
    module, require: id => {
      if (id === './gate') return require('../src/calendar/gate');
      if (id === './journal') return { FileJournal: MemoryJournal };
      if (id === './parser') return { parseEvent: async () => sample };
      if (id === './google') return { ensureAuth: async () => { if (authFails) throw new Error('secret'); return {}; } };
      if (id === 'googleapis') return { google: { calendar: () => ({ calendars: { get: async () => ({ data: { id: 'account-a@example.test' } }) }, events: { insert: async (...args) => { inserts.push(args); return { data: { id: args[0].resource.id } }; } } }) } };
      throw new Error(id);
    }
  });
  const service = module.exports.createCalendarService('unused');
  const { proposal } = await service.propose('Request');
  assert.equal(inserts.length, 0);
  const result = await service.confirm(proposal.operationId, proposal.digest);
  assert.equal(result.proposal.status, 'succeeded');
  assert.equal(inserts[0][1].retry, false);
  assert.equal(inserts[0][0].resource.id, proposal.operationId.replaceAll('-', ''));
  assert.equal(inserts[0][0].resource.start.dateTime, sample.start);
  assert.equal(inserts[0][0].resource.start.timeZone, sample.timeZone);
  const second = (await service.propose('Request')).proposal;
  authFails = true;
  const failed = (await service.confirm(second.operationId, second.digest)).proposal;
  assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'auth'); assert.equal(inserts.length, 1);
});

function fixtureService() {
  const inserts = [];
  const state = { account: 'account-a@example.test', metadataId: undefined, acknowledgement: undefined };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/calendar/service.js'), 'utf8'), {
    module, require: id => {
      if (id === './gate') return require('../src/calendar/gate');
      if (id === './journal') return { FileJournal: MemoryJournal };
      if (id === './parser') return { parseEvent: async () => sample };
      if (id === './google') return { ensureAuth: async () => ({ account: state.account }) };
      if (id === 'googleapis') return { google: { calendar: ({ auth }) => ({
        calendars: { get: async () => ({ data: { id: state.metadataId ?? auth.account } }) },
        events: { insert: async (args, options) => { inserts.push({ account: auth.account, args, options }); return { data: state.acknowledgement ?? { id: args.resource.id } }; } }
      }) } };
      throw new Error(id);
    }
  });
  return { service: module.exports.createCalendarService('unused'), state, inserts };
}
test('desktop service rejects changed accounts and a fresh proposal binds the new destination', async () => {
  const { service, state, inserts } = fixtureService();
  const first = (await service.propose('Request')).proposal;
  assert.equal(first.destination, state.account);
  state.account = 'account-b@example.test';
  const blocked = (await service.confirm(first.operationId, first.digest)).proposal;
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.reason, 'destination-changed');
  assert.equal(inserts.length, 0);
  const next = (await service.propose('Request')).proposal;
  assert.equal(next.destination, state.account);
  assert.equal((await service.confirm(next.operationId, next.digest)).proposal.status, 'succeeded');
  assert.equal(inserts[0].args.calendarId, 'account-b@example.test');
});
test('desktop service rejects unavailable identities and malformed acknowledgements', async () => {
  const { service, state, inserts } = fixtureService();
  state.metadataId = '';
  assert.equal((await service.propose('Request')).type, 'error'); assert.equal(inserts.length, 0);
  state.metadataId = undefined;
  const proposal = (await service.propose('Request')).proposal;
  state.acknowledgement = {};
  const outcome = (await service.confirm(proposal.operationId, proposal.digest)).proposal;
  assert.equal(outcome.status, 'uncertain'); assert.equal(outcome.eventId, undefined);
  await service.confirm(proposal.operationId, proposal.digest);
  assert.equal(inserts.length, 1);
});

test('review renders model text as text and disables both buttons during confirmation', async () => {
  function element() { return { style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, contains: () => false }, addEventListener(name, fn) { this[name] = fn; }, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } }; }
  const input = element(); const status = element(); const response = element();
  let finish; const sent = [];
  const context = vm.createContext({ document: { getElementById: id => ({ input, status, response })[id], createElement: element }, window: { rift: {
    resizeWindow() {}, onFocusInput() {}, calendarOutcomes: async () => [],
    confirmCalendar: (id, digest) => { sent.push([id, digest]); return new Promise(resolve => { finish = resolve; }); }
  } }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/renderer.js'), 'utf8'), context);
  const proposal = { operationId: 'op', digest: 'digest', status: 'proposed', destination: 'reviewed@example.test', action: { ...sample, title: '<img src=x onerror=alert(1)>' } };
  context.proposal = proposal; vm.runInContext('showCalendarProposal(proposal)', context);
  assert.match(response.children[0].textContent, /<img src=x/); assert.equal(response.innerHTML, undefined);
  assert.match(response.children[0].textContent, /Calendar: reviewed@example.test/);
  const confirm = response.children[1]; const cancel = response.children[2];
  const pending = confirm.click(); assert.equal(confirm.disabled, true); assert.equal(cancel.disabled, true);
  assert.deepEqual(sent, [['op', 'digest']]);
  finish({ proposal: { ...proposal, status: 'succeeded' } }); await pending;
  assert.equal(response.children.length, 1); assert.match(status.textContent, /succeeded/);
});
