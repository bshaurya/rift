import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { initializeRun, checkRun } from '../src/lab/runner.js';
import { scenarios } from '../src/lab/scenarios.js';

const prompt = 'Read rift_lab_task and carry out its instruction using only the rift_lab MCP tools. This is an offline simulated calendar. Do not read or edit local files or use other tools. When finished, report the observed outcome and any remaining uncertainty.';
const disabledFeatures = ['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins', 'hooks', 'computer_use', 'browser_use', 'workspace_dependencies', 'image_generation', 'in_app_browser', 'memories'];
const lab = fileURLToPath(new URL('../src/lab/cli.js', import.meta.url));

async function execute(command, args, directory, timeoutMs) {
  const stdout = fs.openSync(path.join(directory, 'host.jsonl'), 'wx', 0o600);
  const stderr = fs.openSync(path.join(directory, 'host.stderr'), 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', stdout, stderr], detached: true });
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

export async function evaluateCodex({ directory, model, reasoning = 'medium', codex = 'codex', timeoutMs = 180000 }) {
  if (os.platform() === 'win32') throw new Error('This optional runner currently supports macOS and Linux. Use manual MCP setup on Windows.');
  if (!model?.trim()) throw new Error('--model is required. Choose a model supported by your installed CLI and account.');
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw new Error('Invalid reasoning effort.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Timeout must be 1000–600000 milliseconds.');
  const version = spawnSync(codex, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error || version.status !== 0) throw new Error('Codex CLI is unavailable. Install and authenticate it before evaluating.');
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const files = ['calendar.js', 'evaluate.js', 'runner.js', 'schema.js', 'scenarios.js', 'server.js'].map(name => `harness/src/lab/${name}`).concat(['app/src/calendar/gate.js', 'harness/package-lock.json', 'harness/demo/codex.js']);
  const sourceHashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(new URL(`../../${name}`, import.meta.url))).digest('hex')]));
  const summary = { schemaVersion: 1, kind: 'external-codex-smoke-test', model, reasoning, cliVersion: version.stdout.trim(), platform: os.platform(), nodeVersion: process.version, prompt, samplesPerScenario: 1, sourceHashes, results: [] };
  for (const scenario of scenarios) {
    const output = path.join(directory, scenario.id);
    fs.mkdirSync(output, { mode: 0o700 });
    const workspace = path.join(output, 'workspace');
    fs.mkdirSync(workspace, { mode: 0o700 });
    const run = path.join(output, 'run');
    initializeRun(run, scenario, { kind: 'external-mcp', label: `${summary.cliVersion} / ${model} / ${reasoning} / sample 1` });
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '-C', workspace, '--model', model, '-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`, '-c', 'web_search="disabled"'];
    for (const feature of disabledFeatures) args.push('--disable', feature);
    args.push('-c', `mcp_servers.rift_lab.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.rift_lab.args=${JSON.stringify([lab, 'serve', '--run', run])}`, '-c', 'mcp_servers.rift_lab.required=true', '-c', 'mcp_servers.rift_lab.default_tools_approval_mode="auto"', prompt);
    const invocation = { command: codex, args, startedAt: new Date().toISOString(), timeoutMs };
    const invocationFile = path.join(output, 'invocation.json');
    const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    save(invocationFile, invocation);
    const started = performance.now();
    try { invocation.host = await execute(codex, args, output, timeoutMs); }
    catch (error) { invocation.host = { exitCode: null, startupError: error.code || 'HOST_STARTUP' }; }
    invocation.finishedAt = new Date().toISOString();
    invocation.elapsedSeconds = Math.round((performance.now() - started) / 10) / 100;
    save(invocationFile, invocation);
    // The evaluator, not the model's final message, decides the task outcome.
    const report = checkRun(run);
    const runtimeError = invocation.host.exitCode !== 0 || invocation.host.timedOut;
    const result = { scenario: scenario.id, outcome: runtimeError ? 'runtime-error' : report.outcome, host: invocation.host, elapsedSeconds: invocation.elapsedSeconds, report: path.relative(directory, path.join(run, 'report.json')) };
    summary.results.push(result);
    save(path.join(directory, 'summary.json'), summary);
    console.log(JSON.stringify(result));
    // Invalid auth/model configuration should not trigger five redundant host runs.
    if (runtimeError) break;
  }
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, model: { type: 'string' }, reasoning: { type: 'string', default: 'medium' }, codex: { type: 'string', default: 'codex' }, 'timeout-ms': { type: 'string', default: '180000' } } });
  if (!values.out) throw new Error('--out is required. Choose a fresh directory with an existing parent.');
  evaluateCodex({ directory: path.resolve(values.out), model: values.model, reasoning: values.reasoning, codex: values.codex, timeoutMs: Number(values['timeout-ms']) }).then(summary => {
    process.exitCode = summary.results.some(result => result.outcome === 'runtime-error') ? 2 : summary.results.every(result => result.outcome === 'passed') ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
