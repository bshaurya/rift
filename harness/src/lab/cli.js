#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioCalendar } from './calendar.js';
import { scenarios, loadScenario } from './scenarios.js';
import { initializeRun, runClient, checkRun, runDemo } from './runner.js';
import { serveLab } from './server.js';

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    scenario: { type: 'string' }, client: { type: 'string', default: 'rift' },
    out: { type: 'string' }, run: { type: 'string' }, label: { type: 'string' }
  } });
  const [command] = positionals;
  if (positionals.length !== 1) throw new Error('Usage: lab list | init | run | serve | check | demo. See harness/LAB.md.');
  if (command === 'list') {
    console.log(JSON.stringify(scenarios.map(({ id, description }) => ({ id, description })), null, 2));
    return 0;
  }
  if (!['init', 'run', 'serve', 'check', 'demo'].includes(command)) throw new Error('Unknown lab command.');
  const rawDirectory = ['serve', 'check'].includes(command) ? values.run : values.out;
  if (!rawDirectory) throw new Error(['serve', 'check'].includes(command) ? '--run is required.' : '--out is required.');
  const directory = path.resolve(rawDirectory);
  if (command === 'serve') {
    const calendar = new ScenarioCalendar(directory);
    try { await serveLab(calendar); } catch (error) { calendar.close(); throw error; }
    return 0;
  }
  let report;
  if (command === 'check') report = checkRun(directory);
  else if (command === 'demo') report = await runDemo(directory);
  else {
    if (!values.scenario) throw new Error('--scenario is required: built-in ID or JSON file path.');
    const scenario = loadScenario(values.scenario);
    if (command === 'init') {
      if (!values.label?.trim()) throw new Error('--label is required to identify the external client and its configuration.');
      initializeRun(directory, scenario, { kind: 'external-mcp', label: values.label });
      console.log(JSON.stringify({ directory, task: scenario.task, serveArguments: ['node', fileURLToPath(import.meta.url), 'serve', '--run', directory] }, null, 2));
      return 0;
    }
    report = await runClient(directory, scenario, values.client);
  }
  console.log(JSON.stringify(report, null, 2));
  return command === 'demo' ? (report.verified ? 0 : 1) : (report.outcome === 'passed' ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Rift lab error: ${error.message}`);
    process.exitCode = 2;
  });
}
