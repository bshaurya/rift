#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Operations } from './operations.js';
import { FakeCalendar } from './fake.js';
import { serve } from './server.js';
import { loadGoogle } from './google.js';
import { authenticate } from './auth.js';
export async function review(operations, id, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('Review requires an interactive terminal. Piped approvals are rejected.');
  const record = operations.get(id);
  output.write(`${JSON.stringify(record, null, 2)}\n`);
  if (record.status !== 'proposed') return record;
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`Type "approve ${id}" to create this event, "cancel" to discard it, or Enter to leave pending: `);
    if (answer === `approve ${id}`) return await operations.approve(id, record.digest);
    if (answer === 'cancel') return operations.cancel(id);
    return record;
  } finally { readline.close(); }
}
async function main() {
  const { values, positionals } = parseArgs({ options: { data: { type: 'string', default: process.env.RIFT_DATA_DIR || path.join(os.homedir(), '.local/share/rift') }, provider: { type: 'string', default: 'google' }, client: { type: 'string' } }, allowPositionals: true });
  if (!path.isAbsolute(values.data)) throw new Error('--data must be an absolute path shared by host and reviewer.');
  const [command, id] = positionals;
  if (command === 'auth') { await authenticate(values.data, values.client); return; }
  if (!['google', 'fake'].includes(values.provider)) throw new Error('Providers: google or fake.');
  const provider = values.provider === 'fake' ? new FakeCalendar(values.data) : loadGoogle(values.data);
  const operations = new Operations(values.data, provider);
  if (command === 'serve') { await serve(operations); return; }
  try {
    const result = command === 'pending' ? operations.pending() : command === 'status' ? operations.get(id) : command === 'review' ? await review(operations, id) : command === 'reconcile' ? await operations.reconcile(id) : (() => { throw new Error('Commands: auth --client PATH, serve, pending, status ID, review ID, reconcile ID.'); })();
    console.log(JSON.stringify(result, null, 2));
  } finally { operations.close(); operations.provider.close?.(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.publicMessage || 'Rift command failed. Check the command, state directory, provider and terminal requirements.'); process.exitCode = 1; });
