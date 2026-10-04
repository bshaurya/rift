import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDemo } from '../src/lab/runner.js';
import { summarizeSamples } from '../src/lab/samples.js';
import { evaluationExitCode } from '../src/lab/host-runner.js';
import { loadReports, renderReport, writeReport } from '../src/lab/report.js';

test('sample counts reject duplicates and never treat partial or empty suites as a pass', () => {
  const results = [{ scenario: 'a', sample: 1, outcome: 'passed' }, { scenario: 'a', sample: 2, outcome: 'failed' }];
  const counts = summarizeSamples(['a', 'b'], 2, results);
  assert.deepEqual(counts.total, { passed: 1, failed: 1, runtimeErrors: 0, notRun: 2, total: 4 });
  assert.throws(() => summarizeSamples(['a'], 2, [results[0], results[0]]), /duplicate/);
  assert.throws(() => summarizeSamples(['a'], 2, [{ ...results[0], outcome: '__proto__' }]), /outcome/);
  assert.equal(evaluationExitCode({ scenarioIds: ['a', 'b'], samplesPerScenario: 2, results }), 2);
  assert.equal(evaluationExitCode({ scenarioIds: ['a'], samplesPerScenario: 1, results: [] }), 2);
  assert.equal(evaluationExitCode({ scenarioIds: ['a'], samplesPerScenario: 1, results: [results[0]] }), 0);
  assert.equal(evaluationExitCode({ scenarioIds: ['a'], samplesPerScenario: 2, results }), 1);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'demo');
  const summary = await runDemo(directory);
  return { root, directory, summary };
}

test('the report exposes failing checks, state, trace, and every scripted result', async t => {
  const { root, directory } = await fixture(t);
  const output = path.join(root, 'report.html');
  const result = writeReport(directory, output);
  assert.deepEqual(result.groups.map(group => [group.label, group.passed, group.failed]), [['naive-retry', 2, 4], ['rift', 6, 0]]);
  const html = fs.readFileSync(output, 'utf8');
  assert.equal((html.match(/<article /g) || []).length, 12);
  for (const value of ['target_count', 'Initial Calendar State', 'Final Calendar State', 'Ordered Provider Calls', 'Scripted', 'Configuration']) {
    assert.match(html.toLowerCase(), new RegExp(value.toLowerCase()));
  }
  assert.throws(() => writeReport(directory, output), { code: 'EEXIST' });
});

test('hostile calendar and client text is displayed without executable HTML', async t => {
  const { directory, summary } = await fixture(t);
  const file = path.join(directory, summary.results[0].report);
  const report = JSON.parse(fs.readFileSync(file));
  const hostile = '</pre><script>fetch("https://example.invalid")</script><img src=x onerror=alert(1)>';
  report.client.label = hostile;
  report.finalState[0].summary = hostile;
  fs.writeFileSync(file, JSON.stringify(report));
  const html = renderReport(loadReports(directory));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes("default-src 'none'"));
});

test('inconsistent checks, mixed scenarios, and escaping report paths fail visibly', async t => {
  const { root, directory, summary } = await fixture(t);
  const summaryFile = path.join(directory, 'summary.json');
  const originalSummary = JSON.stringify(summary);
  const reportFile = path.join(directory, summary.results[0].report);
  const report = JSON.parse(fs.readFileSync(reportFile));
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, outcome: 'failed' }));
  assert.throws(() => loadReports(directory), /disagree/);
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, scenario: { ...report.scenario, definitionSha256: '0'.repeat(64) } }));
  assert.throws(() => loadReports(directory), /different scenario/);
  fs.writeFileSync(reportFile, JSON.stringify(report));
  fs.writeFileSync(path.join(root, 'outside.json'), JSON.stringify(report));
  summary.results[0].report = '../outside.json';
  fs.writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => loadReports(directory), /inside/);
  fs.symlinkSync(path.join(root, 'outside.json'), path.join(directory, 'linked.json'));
  summary.results[0].report = 'linked.json';
  fs.writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => loadReports(directory), /inside/);
  fs.writeFileSync(summaryFile, originalSummary);
});
