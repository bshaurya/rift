import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Operations, freeWindows } from '../src/operations.js';
const action = { action: 'create', title: 'Focus block', start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00', timeZone: 'America/New_York', location: null, description: null, recurrence: null, attendees: [], ambiguities: [] };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-harness-'));
  const calls = []; const provider = { identity: 'test:primary', busy: async () => [], events: async () => [], find: async () => null, create: async (_action, id) => { calls.push(id); return { id }; } };
  const operations = new Operations(directory, provider, options);
  t.after(() => { operations.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, calls, provider, operations };
}
test('overlapping busy intervals merge; invalid availability fails closed', () => {
  const range = { timeMin: action.start, timeMax: '2026-10-05T16:00:00-04:00', timeZone: action.timeZone };
  const free = freeWindows(range, [{ start: '2026-10-05T14:15:00-04:00', end: '2026-10-05T15:00:00-04:00' }, { start: '2026-10-05T14:30:00-04:00', end: '2026-10-05T15:30:00-04:00' }]);
  assert.deepEqual(free, [{ start: '2026-10-05T18:00:00.000Z', end: '2026-10-05T18:15:00.000Z' }, { start: '2026-10-05T19:30:00.000Z', end: '2026-10-05T20:00:00.000Z' }]);
  assert.throws(() => freeWindows(range, [{ start: 'bad', end: 'bad' }]));
});
test('proposal survives reopening; exact requests deduplicate across clients', async t => {
  const { directory, provider, operations, calls } = fixture(t);
  const p = await operations.propose(action); const other = new Operations(directory, provider);
  try { assert.equal(other.get(p.id).status, 'proposed'); assert.equal((await other.propose(action)).id, p.id); await other.approve(p.id, p.digest); assert.equal((await operations.propose(action)).status, 'succeeded'); assert.equal(calls.length, 1); }
  finally { other.close(); }
});
test('conflicts reject before proposal and are rechecked before approval', async t => {
  const { provider, operations, calls } = fixture(t); const p = await operations.propose(action);
  provider.busy = async () => [{ start: action.start, end: action.end }];
  await assert.rejects(operations.propose({ ...action, title: 'Other' }), /overlaps/);
  assert.equal((await operations.approve(p.id, p.digest)).status, 'failed'); assert.equal(calls.length, 0);
});
test('read errors and malformed availability fail before creation and allow a fresh review', async t => {
  for (const failure of ['connection', 'intervals', 'shape']) {
    const { provider, operations, calls } = fixture(t);
    const proposal = await operations.propose(action);
    provider.busy = async () => {
      if (failure === 'connection') throw Object.assign(new Error('Read connection reset'), { code: 'ECONNRESET' });
      return failure === 'intervals' ? [{ start: 'invalid', end: 'invalid' }] : null;
    };
    assert.equal((await operations.approve(proposal.id, proposal.digest)).status, 'failed', failure);
    assert.equal(calls.length, 0);
    provider.busy = async () => [];
    const replacement = await operations.propose(action);
    assert.notEqual(replacement.id, proposal.id);
    assert.equal(replacement.status, 'proposed');
  }
});
test('approval timeout during availability never writes late and allows a fresh review', async t => {
  const { provider, operations, calls } = fixture(t, { timeoutMs: 5 });
  const proposal = await operations.propose(action);
  let finishRead;
  provider.busy = () => new Promise(resolve => { finishRead = resolve; });
  assert.equal((await operations.approve(proposal.id, proposal.digest)).status, 'failed');
  finishRead([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  provider.busy = async () => [];
  assert.notEqual((await operations.propose(action)).id, proposal.id);
});
test('cancelled, stale and altered proposals never execute', async t => {
  let now = 0; const { operations, calls } = fixture(t, { now: () => now });
  const p = await operations.propose(action); await assert.rejects(operations.approve(p.id, 'bad'));
  operations.cancel(p.id); assert.equal((await operations.approve(p.id, p.digest)).status, 'cancelled');
  const second = await operations.propose(action); now = second.expiresAt;
  assert.equal((await operations.approve(second.id, second.digest)).status, 'stale'); assert.equal(calls.length, 0);
});
test('profile mismatch blocks accidental writes into another account', t => {
  const { directory } = fixture(t);
  assert.throws(() => new Operations(directory, { identity: 'other:account' }), /another provider/);
});
test('timeout remains uncertain, no blind retry, and reconciliation only reads', async t => {
  const { operations, provider } = fixture(t, { timeoutMs: 5 }); let writes = 0;
  provider.create = async () => { writes++; return await new Promise(() => {}); };
  const p = await operations.propose(action); assert.equal((await operations.approve(p.id, p.digest)).status, 'uncertain');
  assert.equal((await operations.propose(action)).id, p.id); await operations.approve(p.id, p.digest);
  assert.equal((await operations.reconcile(p.id)).status, 'uncertain');
  provider.find = async id => ({ id }); assert.equal((await operations.reconcile(p.id)).status, 'succeeded'); assert.equal(writes, 1);
});
test('restart recovers abandoned executions only after deadline', async t => {
  let now = 0; const { operations, provider, directory } = fixture(t, { now: () => now }); const p = await operations.propose(action);
  operations.db.prepare("UPDATE operations SET status='executing', deadline=100 WHERE id=?").run(p.id);
  const other = new Operations(directory, provider, { now: () => now });
  try { assert.equal(other.get(p.id).status, 'executing'); now = 101; assert.equal(other.get(p.id).status, 'uncertain'); }
  finally { other.close(); }
});
test('simultaneous separate reviewer processes claim exactly one provider write', async t => {
  const { directory, operations } = fixture(t); const p = await operations.propose(action);
  const moduleURL = new URL('../src/operations.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import {Operations} from ${JSON.stringify(moduleURL)}; const dir=process.argv[1]; const ops=new Operations(dir,{identity:'test:primary',busy:async()=>[],create:async(a,id)=>{fs.appendFileSync(dir+'/calls',id+'\\n'); await new Promise(r=>setTimeout(r,40));return {id};}}); await ops.approve(process.argv[2],process.argv[3]);ops.close();`;
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, p.id, p.digest], { stdio: 'pipe' }); let err=''; child.stderr.on('data', x => { err+=x; }); child.on('exit', code => code === 0 ? resolve() : reject(new Error(err))); });
  await Promise.all([run(), run()]);
  assert.equal(fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n').length, 1);
  assert.equal(operations.get(p.id).status, 'succeeded');
});
