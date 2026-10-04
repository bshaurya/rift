import fs from 'node:fs';
import path from 'node:path';
import { Operations } from '../operations.js';
import { ScenarioCalendar } from './calendar.js';
import { evaluate } from './evaluate.js';
import { loadScenario, scenarios } from './scenarios.js';

export function initializeRun(directory, scenario, client) {
  ScenarioCalendar.initialize(directory, scenario);
  fs.writeFileSync(path.join(directory, 'run.json'), `${JSON.stringify({ schemaVersion: 1, client }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function checkRun(directory) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'));
  if (metadata.schemaVersion !== 1 || !metadata.client || typeof metadata.client.label !== 'string') throw new Error('Invalid run metadata. Initialize a new run.');
  const calendar = new ScenarioCalendar(directory);
  try {
    const { scenario, trace, events } = calendar.inspect();
    const before = scenario.initialEvents.map(({ id, action }) => ({
      id, summary: action.title,
      start: { dateTime: action.start, timeZone: action.timeZone },
      end: { dateTime: action.end, timeZone: action.timeZone },
      location: action.location, description: action.description
    })).sort((a, b) => a.id.localeCompare(b.id));
    const report = evaluate({ scenario, before, after: events, trace, client: metadata.client });
    fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally { calendar.close(); }
}

async function naiveRetry(calendar, action) {
  const range = { timeMin: action.start, timeMax: action.end, timeZone: action.timeZone };
  if ((await calendar.busy(range)).length) return { status: 'blocked' };
  try {
    const result = await calendar.create(action, 'naive-first');
    if (!result?.id) throw new Error('Missing acknowledgement');
    return { status: 'succeeded', eventId: result.id };
  } catch (error) {
    if ([400, 401, 403, 404, 409, 422, 429].includes(Number(error.code))) return { status: 'failed', code: error.code };
    // Deliberately broken baseline: it mistakes an uncertain response for a failed write.
    const result = await calendar.create(action, 'naive-retry');
    return { status: 'succeeded', eventId: result.id };
  }
}

async function riftClient(operations, action) {
  const proposal = await operations.propose(action);
  let result = await operations.approve(proposal.id, proposal.digest);
  if (result.status === 'uncertain') result = await operations.reconcile(result.id);
  return { status: result.status, reason: result.reason, eventId: result.eventId };
}

export async function runClient(directory, scenario, clientName) {
  if (!['rift', 'naive-retry'].includes(clientName)) throw new Error('Clients: rift or naive-retry.');
  initializeRun(directory, scenario, { kind: 'scripted-action-client', label: clientName });
  const calendar = new ScenarioCalendar(directory);
  let operations;
  try {
    if (clientName === 'rift') operations = new Operations(path.join(directory, 'client'), calendar);
    let result;
    try {
      result = clientName === 'rift'
        ? await riftClient(operations, scenario.task.event)
        : await naiveRetry(calendar, scenario.task.event);
    } catch (error) {
      // Database failures invalidate the run; client failures still have evidence to grade.
      if (error?.code === 'LAB_TRANSACTION' || String(error?.code).startsWith('ERR_SQLITE')) throw error;
      result = {
        status: 'error',
        error: {
          code: ['string', 'number'].includes(typeof error?.code) ? error.code : 'CLIENT_ERROR',
          message: error?.publicMessage || 'Scripted client execution failed.'
        }
      };
    }
    fs.writeFileSync(path.join(directory, 'client-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  } finally {
    try { operations?.close(); } finally { calendar.close(); }
  }
  return checkRun(directory);
}

export async function runDemo(directory) {
  if (fs.existsSync(directory)) throw new Error('Demo output directory must not exist. Choose a fresh path.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const results = [];
  for (const scenario of scenarios) {
    for (const client of ['naive-retry', 'rift']) {
      const runDirectory = path.join(directory, scenario.id, client);
      const report = await runClient(runDirectory, loadScenario(scenario.id), client);
      results.push({ scenario: scenario.id, client, outcome: report.outcome, report: path.relative(directory, path.join(runDirectory, 'report.json')) });
    }
  }
  const expectedFailures = new Set(['commit-timeout', 'timeout-before', 'malformed-ack', 'concurrent-change']);
  const verified = results.every(result => result.outcome === (result.client === 'naive-retry' && expectedFailures.has(result.scenario) ? 'failed' : 'passed'));
  const summary = { schemaVersion: 1, kind: 'scripted-action-client-comparison', verified, results };
  fs.writeFileSync(path.join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}
