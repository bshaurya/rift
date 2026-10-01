import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeRun, checkRun } from '../src/lab/runner.js';
import { loadScenario } from '../src/lab/scenarios.js';

const cli = fileURLToPath(new URL('../src/lab/cli.js', import.meta.url));
const unpack = result => JSON.parse(result.content[0].text);
async function connect(directory) {
  const client = new Client({ name: 'lab-test-host', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--run', directory], stderr: 'pipe' }));
  return client;
}

test('external MCP host gets only task/read/create tools; committed timeout survives host restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-lab-mcp-'));
  const scenario = loadScenario('commit-timeout');
  initializeRun(directory, scenario, { kind: 'external-mcp', label: 'SDK integration host (no model)' });
  let client;
  try {
    client = await connect(directory);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['rift_lab_create_event', 'rift_lab_events', 'rift_lab_get_event', 'rift_lab_task']);
    const task = unpack(await client.callTool({ name: 'rift_lab_task', arguments: {} }));
    assert.deepEqual(task, scenario.task);
    assert.equal(Object.hasOwn(task, 'faults'), false);
    assert.equal(Object.hasOwn(task, 'expected'), false);
    const bad = await client.callTool({ name: 'rift_lab_create_event', arguments: { eventId: 'desired', event: { ...task.event, extra: true } } });
    assert.equal(bad.isError, true);
    const response = await client.callTool({ name: 'rift_lab_create_event', arguments: { eventId: 'desired', event: task.event } });
    assert.equal(response.isError, true);
    const observation = unpack(response);
    assert.ok(!/committed|before mutation|after mutation/i.test(observation.message));
    await client.close();
    client = await connect(directory);
    const found = unpack(await client.callTool({ name: 'rift_lab_get_event', arguments: { eventId: 'desired' } }));
    assert.equal(found.id, 'desired');
    assert.equal(found.summary, task.event.title);
    assert.equal(checkRun(directory).outcome, 'passed');
    const duplicate = await client.callTool({ name: 'rift_lab_create_event', arguments: { eventId: 'accidental-retry', event: task.event } });
    assert.ok(!duplicate.isError);
    assert.equal(checkRun(directory).outcome, 'failed');
    assert.equal((await client.callTool({ name: 'rift_lab_reset', arguments: {} })).isError, true);
  } finally {
    await client?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
