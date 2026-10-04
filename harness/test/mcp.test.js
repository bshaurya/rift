import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { review } from '../src/cli.js';
const action = { action: 'create', title: 'Focus block', start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00', timeZone: 'America/New_York', location: null, description: null, recurrence: null, attendees: [], ambiguities: [] };
const dataOf = result => JSON.parse(result.content[0].text);
test('real MCP handshake exposes reads/proposals/outcomes but no approval or execute tool', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-mcp-'));
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--provider', 'fake', '--data', directory], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools(); assert.equal(tools.length, 7); assert.ok(!tools.some(t => /approve|confirm|execute/.test(t.name)));
    const invalid = await client.callTool({ name: 'rift_propose_event', arguments: { event: { ...action, extra: true } } }); assert.equal(invalid.isError, true);
    const available = dataOf(await client.callTool({ name: 'rift_availability', arguments: { timeMin: action.start, timeMax: action.end, timeZone: action.timeZone, durationMinutes: 30 } })); assert.equal(available.suggestedSlots.length, 1);
    const p = dataOf(await client.callTool({ name: 'rift_propose_event', arguments: { event: action } })); assert.equal(p.status, 'proposed');
    assert.equal(dataOf(await client.callTool({ name: 'rift_events', arguments: { timeMin: action.start, timeMax: action.end, timeZone: action.timeZone } })).length, 0);
    const repeated = dataOf(await client.callTool({ name: 'rift_propose_event', arguments: { event: action } })); assert.equal(repeated.id, p.id);
    assert.equal((await client.callTool({ name: 'rift_approve', arguments: { operationId: p.id } })).isError, true);
    const cancelled = dataOf(await client.callTool({ name: 'rift_cancel', arguments: { operationId: p.id } })); assert.equal(cancelled.status, 'cancelled');
    assert.equal(dataOf(await client.callTool({ name: 'rift_operation', arguments: { operationId: p.id } })).status, 'cancelled');
  } finally { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('local review rejects piped input before touching proposal', async () => {
  await assert.rejects(review({ get: () => { throw new Error('touched'); } }, 'id', { isTTY: false }, { isTTY: true }), /interactive terminal/);
});

test('interactive local review displays the stored action and requires the exact operation phrase', async () => {
  const { PassThrough } = await import('node:stream');
  const { Operations } = await import('../src/operations.js');
  const { FakeCalendar } = await import('../src/fake.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-review-'));
  const provider = new FakeCalendar(directory); const operations = new Operations(directory, provider);
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.isTTY = true; output.columns = 120;
  let printed = ''; output.on('data', data => { printed += data.toString(); });
  try {
    const p = await operations.propose(action);
    const pending = review(operations, p.id, input, output);
    setTimeout(() => input.write(`approve ${p.id}\n`), 5);
    assert.equal((await pending).status, 'succeeded');
    assert.ok(printed.includes(action.title)); assert.ok(printed.includes(action.timeZone)); assert.ok(printed.includes(p.id));
    assert.equal((await provider.events({ timeMin: action.start, timeMax: action.end })).length, 1);
  } finally { input.destroy(); output.destroy(); operations.close(); provider.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('two independent MCP hosts share one proposal and see the same reviewed outcome', async () => {
  const { Operations } = await import('../src/operations.js');
  const { FakeCalendar } = await import('../src/fake.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-two-hosts-'));
  const clients = ['codex-like-host', 'claude-like-host'].map(name => new Client({ name, version: '1.0.0' }));
  let reviewer, provider;
  try {
    await Promise.all(clients.map(client => client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--provider', 'fake', '--data', directory], stderr: 'pipe' }))));
    const proposals = await Promise.all(clients.map(client => client.callTool({ name: 'rift_propose_event', arguments: { event: action } }).then(dataOf)));
    assert.equal(proposals[0].id, proposals[1].id);
    provider = new FakeCalendar(directory); reviewer = new Operations(directory, provider);
    await reviewer.approve(proposals[0].id, proposals[0].digest);
    for (const client of clients) {
      assert.equal(dataOf(await client.callTool({ name: 'rift_operation', arguments: { operationId: proposals[0].id } })).status, 'succeeded');
      assert.equal(dataOf(await client.callTool({ name: 'rift_propose_event', arguments: { event: action } })).id, proposals[0].id);
    }
    assert.equal((await provider.events({ timeMin: action.start, timeMax: action.end })).length, 1);
  } finally { reviewer?.close(); provider?.close(); await Promise.all(clients.map(client => client.close())); fs.rmSync(directory, { recursive: true, force: true }); }
});
