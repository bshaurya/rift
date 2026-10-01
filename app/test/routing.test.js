const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('real IPC registration gates both create routes and blocks calendar/workflow bypasses before authentication', async () => {
  const handlers = {}; const calls = []; let intent = 'CALENDAR_CREATE'; let workflow = null;
  const service = {
    propose: async input => { calls.push(['propose', input]); return { type: 'calendar-proposal' }; },
    confirm: async (...args) => { calls.push(['confirm', ...args]); },
    cancel: async (...args) => { calls.push(['cancel', ...args]); }, outcomes: () => []
  };
  const requireFake = id => {
    if (id === 'path') return path;
    if (id === 'dotenv') return { config() {} };
    if (id === 'electron') return {
      app: { isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {}, getPath: () => '/fake' },
      ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} }, shell: {}, globalShortcut: {}
    };
    if (id === './calendar/service') return { createCalendarService: () => service };
    if (id === './utils/intentDetector') return { detectIntent: async () => intent };
    if (id === './utils/workflowManager') return { detectWorkflow: async () => workflow };
    if (id === './calendar/google') return new Proxy({}, { get: () => () => { throw new Error('Authentication or direct provider write reached'); } });
    return {};
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), { require: requireFake, __dirname: '/fake/src', process: { env: {} }, console: { log() {}, error() {} }, global: {} });
  assert.equal((await handlers['route-prompt']({}, 'create an event')).type, 'calendar-proposal');
  assert.equal((await handlers['parse-and-create-event']({}, 'alternate request')).type, 'calendar-proposal');
  await handlers['calendar-confirm']({}, 'id', 'digest'); await handlers['calendar-cancel']({}, 'id', 'digest');
  assert.deepEqual(calls, [['propose', 'create an event'], ['propose', 'alternate request'], ['confirm', 'id', 'digest'], ['cancel', 'id', 'digest']]);
  for (intent of ['CALENDAR_DELETE', 'CALENDAR_MODIFY', 'MEET_CREATE', 'MEET_SHARE']) {
    assert.match((await handlers['route-prompt']({}, 'request')).error, /blocked/);
  }
  assert.match((await handlers['route-prompt']({}, 'create a google meet')).error, /blocked/);
  for (const workflowType of ['CALENDAR_AND_DOCS', 'CUSTOM', 'MEET_AND_EMAIL']) {
    workflow = { isWorkflow: true, workflowType };
    assert.match((await handlers['route-prompt']({}, 'request')).error, /blocked/);
  }
  assert.equal(calls.length, 4);
});
