import fs from 'node:fs';
import path from 'node:path';
import { summarizeSamples } from './samples.js';
import { scenarios } from './scenarios.js';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const json = value => `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
const details = (title, content) => `<details><summary>${escape(title)}</summary>${content}</details>`;
const calendar = events => `<div class="table"><table><thead><tr><th>Event ID</th><th>Title</th><th>Start</th><th>End</th></tr></thead><tbody>${events.map(event => `<tr><td>${escape(event.id)}</td><td>${escape(event.summary)}</td><td>${escape(event.start?.dateTime)}</td><td>${escape(event.end?.dateTime)}</td></tr>`).join('')}</tbody></table></div>${details('Full Event Records', json(events))}`;

export function loadReports(directory) {
  const root = fs.realpathSync(directory);
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
  if (summary.schemaVersion !== 1 || !Array.isArray(summary.results)) throw new Error('Invalid evaluation summary.');
  const scripted = summary.kind === 'scripted-action-client-comparison';
  if (!scripted && !/^external-(codex|claude)-smoke-test$/.test(summary.kind)) throw new Error('Unsupported evaluation kind.');
  const scenarioIds = summary.scenarioIds ?? scenarios.map(scenario => scenario.id);
  const groups = scripted
    ? ['naive-retry', 'rift'].map(client => ({ label: client, results: summary.results.filter(result => result.client === client), counts: null }))
    : [{ label: `${summary.cliVersion} / ${summary.model} / ${summary.reasoning}`, results: summary.results, counts: null }];
  if (scripted && groups.reduce((count, group) => count + group.results.length, 0) !== summary.results.length) throw new Error('Unknown scripted client.');
  for (const group of groups) group.counts = summarizeSamples(scenarioIds, scripted ? 1 : summary.samplesPerScenario, group.results);
  const definitions = new Map();
  const reports = summary.results.map(result => {
    if (typeof result.report !== 'string' || path.isAbsolute(result.report)) throw new Error('Report path must be relative.');
    const file = fs.realpathSync(path.resolve(root, result.report));
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Report must be inside the evaluation directory.');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (report.schemaVersion !== 1 || report.scenario?.id !== result.scenario || !Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => typeof check.passed !== 'boolean') || !Array.isArray(report.trace) || !Array.isArray(report.initialState) || !Array.isArray(report.finalState)) throw new Error('Invalid resource report.');
    const outcome = report.checks.every(check => check.passed) ? 'passed' : 'failed';
    if (report.outcome !== outcome || (result.outcome !== 'runtime-error' && result.outcome !== outcome)) throw new Error('Summary and resource checks disagree.');
    if (!/^[a-f0-9]{64}$/.test(report.scenario.definitionSha256)) throw new Error('Missing scenario definition hash.');
    const definition = JSON.stringify([report.scenario.version, report.scenario.definitionSha256]);
    if (definitions.has(result.scenario) && definitions.get(result.scenario) !== definition) throw new Error('Samples use different scenario definitions.');
    definitions.set(result.scenario, definition);
    return { result, report };
  });
  return { summary, groups, scenarioIds, reports };
}

export function renderReport(evaluation) {
  const { summary, groups, scenarioIds, reports } = evaluation;
  const rows = groups.flatMap(group => scenarioIds.map(id => {
    const count = group.counts.byScenario[id];
    const candidates = reports.filter(({ result }) => result.scenario === id && group.results.includes(result));
    const target = candidates.find(({ result }) => result.outcome !== 'passed') ?? candidates[0];
    const label = target ? `<a href="#case-${reports.indexOf(target)}">${escape(id)}</a>` : escape(id);
    return `<tr><td>${escape(group.label)}</td><th scope="row">${label}</th><td>${count.passed}</td><td>${count.failed}</td><td>${count.runtimeErrors}</td><td>${count.notRun}</td><td>${count.total}</td></tr>`;
  })).join('');
  const samples = [...reports].sort((a, b) => Number(a.result.outcome === 'passed') - Number(b.result.outcome === 'passed')).map(entry => {
    const { result, report } = entry;
    const failed = report.checks.filter(check => !check.passed);
    const label = `${result.scenario} / ${result.client ?? `sample ${result.sample ?? 1}`} / ${result.outcome}`;
    const checks = failed.length ? `<h3>Failed Checks</h3><div class="table"><table><thead><tr><th>Check</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${failed.map(check => `<tr><th scope="row">${escape(check.name)}</th><td><code>${escape(JSON.stringify(check.expected))}</code></td><td><code>${escape(JSON.stringify(check.actual))}</code></td></tr>`).join('')}</tbody></table></div>` : '<p>All resource checks passed.</p>';
    const trace = report.trace.map(call => details(`Call ${call.sequence}: ${call.method}${call.error ? ' (error)' : ''}`, json(call))).join('');
    return `<article id="case-${reports.indexOf(entry)}" class="${escape(result.outcome)}"><h2>${escape(label)}</h2><p>${escape(report.client?.label ?? '')}</p>${result.outcome === 'runtime-error' ? `<p>The host did not complete normally. These resource checks do not count as a completed task.</p>${json(result.host)}` : ''}${checks}${details('All Checks', json(report.checks))}${details('Initial Calendar State', calendar(report.initialState))}${details('Final Calendar State', calendar(report.finalState))}${details('Ordered Provider Calls', trace || '<p>No provider calls.</p>')}${details('Scenario Identity', json(report.scenario))}</article>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Rift Evaluation Report</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1120px;margin:40px auto;padding:0 20px;color:#17202a;background:#f7f8fa}h1,h2,h3{line-height:1.2}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px;text-align:left;border-bottom:1px solid #ccd2d8;vertical-align:top}caption{text-align:left;font-weight:600;margin-bottom:8px}.table{overflow-x:auto}article{background:white;border-left:5px solid #27804c;margin:24px 0;padding:18px;scroll-margin-top:20px}.failed{border-color:#ba3838}.runtime-error{border-color:#9c6500}summary{cursor:pointer;padding:8px 0;font-weight:600}pre,code{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}pre{background:#f0f2f5;padding:12px}details details{margin-left:12px}a{color:#205ba6}</style></head>
<body><h1>Rift Evaluation Report</h1><p>${escape(summary.kind)}</p>
<p>Task outcomes come from saved calendar state and provider traces. Host runtime errors and requested samples that never ran are counted separately. Final natural-language answers are not graded. Small samples of six fixed scenarios do not establish general reliability.</p>
${summary.kind === 'scripted-action-client-comparison' ? '<p>This comparison uses scripted clients, not model performance measurements.</p>' : '<p>Each sample uses a fresh host process and calendar. Sample numbers identify independent runs, not retries.</p>'}
<div class="table"><table><caption>Counts per Scenario</caption><thead><tr><th>Client</th><th>Scenario</th><th>Passed</th><th>Failed</th><th>Runtime Error</th><th>Not Run</th><th>Requested</th></tr></thead><tbody>${rows}</tbody></table></div>
${details('Configuration and Source Hashes', json(Object.fromEntries(Object.entries(summary).filter(([key]) => !['results', 'counts'].includes(key)))))}
<h2>Individual Samples</h2><p>Failures appear first. Scenario links jump to the first failed sample, or the first sample when none failed.</p>${samples || '<p>No samples completed.</p>'}
</body></html>\n`;
}

export function writeReport(directory, output) {
  const evaluation = loadReports(directory);
  fs.writeFileSync(output, renderReport(evaluation), { flag: 'wx', mode: 0o600 });
  return { output, groups: evaluation.groups.map(({ label, counts }) => ({ label, ...counts.total })) };
}
