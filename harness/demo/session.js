import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Operations } from '../src/operations.js';
import { FakeCalendar } from '../src/fake.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-demo-'));
const client = new Client({ name: 'demo-host', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve', '--provider', 'fake', '--data', directory], stderr: 'pipe' });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};
let reviewer;
try {
  await client.connect(transport);
  console.log('1. Host connects over MCP; no Gemini key or Electron needed.');
  const range = { timeMin: '2026-10-05T13:00:00-04:00', timeMax: '2026-10-05T16:00:00-04:00', timeZone: 'America/New_York', durationMinutes: 30 };
  console.log('2. Existing events:', await call('rift_events', range));
  console.log('3. Available windows:', await call('rift_availability', range));
  const event = { action: 'create', title: 'Focus block', start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00', timeZone: range.timeZone, location: null, description: null, recurrence: null, attendees: [], ambiguities: [] };
  const p = await call('rift_propose_event', { event });
  console.log('4. Proposed for local review:', p.id, p.status);
  console.log('   MCP cannot approve; fake provider has not added the event.');
  reviewer = new Operations(directory, new FakeCalendar(directory));
  // Demo-only simulated local review. The production CLI requires interactive input.
  await reviewer.approve(p.id, p.digest);
  console.log('5. Simulated local review completed; host sees:', (await call('rift_operation', { operationId: p.id })).status);
  console.log('6. Same proposal reused:', (await call('rift_propose_event', { event })).id === p.id);
} finally {
  reviewer?.close(); reviewer?.provider.close?.(); await client.close(); fs.rmSync(directory, { recursive: true, force: true });
}
