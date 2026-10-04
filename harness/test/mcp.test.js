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
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--data', directory], stderr: 'pipe' });
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
