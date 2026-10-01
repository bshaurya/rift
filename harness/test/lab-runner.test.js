import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeRun, checkRun, runClient, runDemo } from '../src/lab/runner.js';
import { loadScenario } from '../src/lab/scenarios.js';
import { ScenarioCalendar } from '../src/lab/calendar.js';

const cli = fileURLToPath(new URL('../src/lab/cli.js', import.meta.url));
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-lab-runner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('same six scenarios expose unsafe clients and verify the existing Rift Operations client', async t => {
  const directory = path.join(temporary(t), 'demo');
  const summary = await runDemo(directory);
  assert.equal(summary.kind, 'scripted-action-client-comparison');
  assert.equal(summary.verified, true);
  assert.equal(summary.results.length, 12);
  assert.equal(summary.results.filter(r => r.client === 'rift' && r.outcome === 'passed').length, 6);
  assert.equal(summary.results.filter(r => r.client === 'naive-retry' && r.outcome === 'failed').length, 4);
  const unsafe = JSON.parse(fs.readFileSync(path.join(directory, 'commit-timeout/naive-retry/report.json')));
  const corrected = JSON.parse(fs.readFileSync(path.join(directory, 'commit-timeout/rift/report.json')));
  assert.equal(unsafe.finalState.filter(e => e.summary === 'Focus block').length, 2);
  assert.equal(corrected.finalState.filter(e => e.summary === 'Focus block').length, 1);
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'timeout-before/rift/client-result.json')));
  assert.equal(result.status, 'uncertain');
  const limited = JSON.parse(fs.readFileSync(path.join(directory, 'rate-limit/rift/client-result.json')));
  assert.equal(limited.status, 'failed');
  await assert.rejects(runDemo(directory), /must not exist/);
});

test('checking an unexercised run cannot pass an expected-empty calendar', t => {
  const directory = path.join(temporary(t), 'run');
  initializeRun(directory, loadScenario('timeout-before'), { kind: 'external-mcp', label: 'test host' });
  assert.equal(checkRun(directory).outcome, 'failed');
});

test('CLI distinguishes failed checks from missing/invalid runs and preserves existing data', t => {
  const parent = temporary(t);
  const directory = path.join(parent, 'run');
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(invoke(['check', '--run', directory]).status, 2);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(invoke(['init', '--scenario', 'timeout-before', '--out', directory, '--label', 'manual test']).status, 0);
  const metadata = fs.readFileSync(path.join(directory, 'run.json'), 'utf8');
  assert.equal(invoke(['check', '--run', directory]).status, 1);
  assert.equal(invoke(['init', '--scenario', 'clean-create', '--out', directory, '--label', 'replacement']).status, 2);
  assert.equal(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'), metadata);
  const malformed = path.join(parent, 'invalid.json');
  fs.writeFileSync(malformed, JSON.stringify({ ...loadScenario('clean-create'), unknown: true }));
  assert.equal(invoke(['init', '--scenario', malformed, '--out', path.join(parent, 'invalid-run'), '--label', 'test']).status, 2);
  assert.equal(fs.existsSync(path.join(parent, 'invalid-run')), false);
});

test('a scripted client cannot silently reset a used run', async t => {
  const directory = path.join(temporary(t), 'run');
  const scenario = loadScenario('commit-timeout');
  const first = await runClient(directory, scenario, 'rift');
  await assert.rejects(runClient(directory, scenario, 'naive-retry'));
  assert.deepEqual(checkRun(directory), first);
});

test('lucky final state cannot pass until the client diagnoses an uncertain write', async t => {
  const parent = temporary(t);
  for (const name of ['commit-timeout', 'timeout-before', 'malformed-ack']) {
    const directory = path.join(parent, name);
    const scenario = loadScenario(name);
    initializeRun(directory, scenario, { kind: 'scripted-action-client', label: 'abandon-then-diagnose' });
    const calendar = new ScenarioCalendar(directory);
    try {
      try { await calendar.create(scenario.task.event, 'requested'); }
      catch (error) { assert.equal(error.code, 'ETIMEDOUT'); }
      assert.equal(checkRun(directory).outcome, 'failed', `${name}: final state alone is insufficient`);
      await calendar.find('unrelated');
      assert.equal(checkRun(directory).outcome, 'failed', `${name}: irrelevant reads cannot count`);
      await calendar.find('requested');
      assert.equal(checkRun(directory).outcome, 'passed', `${name}: reading the attempted ID diagnoses the outcome`);
    } finally { calendar.close(); }
  }
});

test('abandoning a task after an apparently free slot is not successful conflict handling', async t => {
  const directory = path.join(temporary(t), 'run');
  const scenario = loadScenario('concurrent-change');
  initializeRun(directory, scenario, { kind: 'scripted-action-client', label: 'abandon-then-recheck' });
  const calendar = new ScenarioCalendar(directory);
  const range = { timeMin: scenario.task.event.start, timeMax: scenario.task.event.end, timeZone: scenario.task.event.timeZone };
  try {
    assert.equal((await calendar.events(range)).length, 0);
    assert.equal(checkRun(directory).outcome, 'failed');
    assert.equal((await calendar.events(range)).length, 1);
    assert.equal(checkRun(directory).outcome, 'passed');
  } finally { calendar.close(); }
});
