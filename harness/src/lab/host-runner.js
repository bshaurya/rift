import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeRun, checkRun } from './runner.js';
import { scenarios } from './scenarios.js';

export const labPrompt = 'Read rift_lab_task and carry out its instruction using only the rift_lab MCP tools. This is an offline simulated calendar. Do not read or edit local files or use other tools. When finished, report the observed outcome and any remaining uncertainty.';
export const labScript = fileURLToPath(new URL('./cli.js', import.meta.url));
export const labTools = ['rift_lab_task', 'rift_lab_events', 'rift_lab_get_event', 'rift_lab_create_event'];
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export const evaluationExitCode = summary => summary.results.some(result => result.outcome === 'runtime-error') ? 2 : summary.results.every(result => result.outcome === 'passed') ? 0 : 1;

async function execute(command, args, directory, timeoutMs, cwd) {
  const stdout = fs.openSync(path.join(directory, 'host.jsonl'), 'wx', 0o600);
  const stderr = fs.openSync(path.join(directory, 'host.stderr'), 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', stdout, stderr], detached: true, cwd });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }, timeoutMs);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut });
      });
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
}

export async function evaluateHost({ directory, host, model, reasoning, executable, timeoutMs = 180000, buildInvocation, inspectHost }) {
  if (os.platform() === 'win32') throw new Error('This optional runner currently supports macOS and Linux. Use manual MCP setup on Windows.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Timeout must be 1000–600000 milliseconds.');
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error || version.status !== 0) throw new Error(`${host} CLI is unavailable. Install and authenticate it before evaluating.`);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const files = ['calendar.js', 'evaluate.js', 'runner.js', 'schema.js', 'scenarios.js', 'server.js', 'host-runner.js'].map(name => `harness/src/lab/${name}`).concat(['app/src/calendar/gate.js', 'harness/package-lock.json', 'harness/demo/codex.js', 'harness/demo/claude.js']);
  const sourceHashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(new URL(`../../../${name}`, import.meta.url))).digest('hex')]));
  const summary = { schemaVersion: 1, kind: `external-${host.toLowerCase()}-smoke-test`, model, reasoning, cliVersion: version.stdout.trim(), platform: os.platform(), nodeVersion: process.version, prompt: labPrompt, samplesPerScenario: 1, sourceHashes, results: [] };
  for (const scenario of scenarios) {
    const output = path.join(directory, scenario.id);
    fs.mkdirSync(output, { mode: 0o700 });
    const workspace = path.join(output, 'workspace');
    fs.mkdirSync(workspace, { mode: 0o700 });
    const run = path.join(output, 'run');
    initializeRun(run, scenario, { kind: 'external-mcp', label: `${summary.cliVersion} / ${model} / ${reasoning} / sample 1` });
    const { args, cwd = workspace } = buildInvocation({ workspace, run, model, reasoning });
    const invocation = { command: executable, args, cwd, startedAt: new Date().toISOString(), timeoutMs };
    const invocationFile = path.join(output, 'invocation.json');
    save(invocationFile, invocation);
    const started = performance.now();
    try { invocation.host = await execute(executable, args, output, timeoutMs, cwd); }
    catch (error) { invocation.host = { exitCode: null, startupError: error.code || 'HOST_STARTUP' }; }
    if (inspectHost && invocation.host.exitCode === 0) {
      try { Object.assign(invocation.host, inspectHost(output)); }
      catch { invocation.host.protocolError = 'Invalid or incomplete host transcript.'; }
    }
    invocation.finishedAt = new Date().toISOString();
    invocation.elapsedSeconds = Math.round((performance.now() - started) / 10) / 100;
    save(invocationFile, invocation);
    // Resource state and call history determine task success, independently of host claims.
    const report = checkRun(run);
    const runtimeError = invocation.host.exitCode !== 0 || invocation.host.timedOut || invocation.host.protocolError || invocation.host.resultError;
    const result = { scenario: scenario.id, outcome: runtimeError ? 'runtime-error' : report.outcome, host: invocation.host, elapsedSeconds: invocation.elapsedSeconds, report: path.relative(directory, path.join(run, 'report.json')) };
    summary.results.push(result);
    save(path.join(directory, 'summary.json'), summary);
    console.log(JSON.stringify(result));
    if (runtimeError) break;
  }
  return summary;
}
