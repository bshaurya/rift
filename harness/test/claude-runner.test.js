import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateClaude, inspectClaude } from '../demo/claude.js';
import { labTools } from '../src/lab/host-runner.js';

function fixture(t, result) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-claude-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, 'fake claude');
  const records = [
    { type: 'system', subtype: 'init', model: 'fixture-model', tools: labTools.map(name => `mcp__rift_lab__${name}`), mcp_servers: [{ name: 'rift_lab', status: 'connected' }] },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done. Everything succeeded.', ...result }
  ];
  fs.writeFileSync(claude, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('fixture-claude 1'); process.exit(0); }\nfor (const record of ${JSON.stringify(records)}) console.log(JSON.stringify(record));`, { mode: 0o700 });
  return { directory, claude };
}

test('a successful Claude process and final claim cannot pass unexercised tasks', { skip: os.platform() === 'win32' }, async t => {
  const { directory, claude } = fixture(t);
  const output = path.join(directory, 'results');
  const summary = await evaluateClaude({ directory: output, claude });
  assert.equal(summary.results.length, 6);
  assert.ok(summary.results.every(result => result.outcome === 'failed'));
  assert.ok(summary.results.every(result => result.host.resolvedModel === 'fixture-model'));
  const invocation = JSON.parse(fs.readFileSync(path.join(output, 'clean-create/invocation.json')));
  const value = name => invocation.args[invocation.args.indexOf(name) + 1];
  assert.equal(value('--tools'), '');
  assert.equal(value('--setting-sources'), '');
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.ok(invocation.args.includes('--restricted'));
  assert.ok(invocation.args.includes('--strict-mcp-config'));
  assert.deepEqual(Object.keys(JSON.parse(value('--mcp-config')).mcpServers), ['rift_lab']);
  assert.deepEqual(value('--allowedTools').split(','), labTools.map(name => `mcp__rift_lab__${name}`));
  assert.equal(summary.prompt, JSON.parse(fs.readFileSync(path.join(output, 'summary.json'))).prompt);
});

test('Claude completion errors stop as runtime failures even when the process exits zero', { skip: os.platform() === 'win32' }, async t => {
  const { directory, claude } = fixture(t, { subtype: 'error_max_turns', is_error: true });
  const output = path.join(directory, 'results');
  const summary = await evaluateClaude({ directory: output, claude });
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].host.exitCode, 0);
  assert.equal(summary.results[0].host.resultSubtype, 'error_max_turns');
  assert.equal(summary.results[0].outcome, 'runtime-error');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, summary.results[0].report))).outcome, 'failed');
});

test('missing Claude completion or disconnected lab is not a successful host run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-claude-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'host.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'init', model: 'fixture' }) + '\n');
  assert.throws(() => inspectClaude(directory), /completion/);
  fs.appendFileSync(file, JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
  assert.equal(inspectClaude(directory).resultError, true);
});
