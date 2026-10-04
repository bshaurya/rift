import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCodex } from '../demo/codex.js';

function fixture(t, script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const codex = path.join(directory, 'fake cli');
  fs.writeFileSync(codex, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('fixture-host 1'); process.exit(0); }\n${script}`, { mode: 0o700 });
  return { directory, codex };
}
test('host startup rejection retains evidence, is a runtime error, and stops the suite', { skip: os.platform() === 'win32' }, async t => {
  const { directory, codex } = fixture(t, "console.error('Model unavailable'); process.exit(1);");
  const output = path.join(directory, 'results');
  const summary = await evaluateCodex({ directory: output, model: 'fixture', codex });
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].outcome, 'runtime-error');
  assert.equal(summary.results[0].host.exitCode, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, summary.results[0].report))).outcome, 'failed');
  assert.match(fs.readFileSync(path.join(output, 'clean-create/host.stderr'), 'utf8'), /Model unavailable/);
  const invocation = JSON.parse(fs.readFileSync(path.join(output, 'clean-create/invocation.json')));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('read-only'));
  assert.ok(invocation.args.includes('shell_tool'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'summary.json'))), summary);
  await assert.rejects(evaluateCodex({ directory: output, model: 'fixture', codex }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'summary.json'))), summary);
});
test('host timeout kills its process group before evaluating and cannot write later', { skip: os.platform() === 'win32' }, async t => {
  const { directory, codex } = fixture(t, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const workspace = process.argv[process.argv.indexOf('-C') + 1];
    const marker = path.join(workspace, 'late-write');
    spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late"), 1800)', marker], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `);
  const output = path.join(directory, 'results');
  const summary = await evaluateCodex({ directory: output, model: 'fixture', codex, timeoutMs: 1000 });
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].outcome, 'runtime-error');
  assert.equal(summary.results[0].host.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(fs.existsSync(path.join(output, 'clean-create/workspace/late-write')), false);
});
