#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Operations } from './operations.js';
import { FakeCalendar } from './fake.js';
import { serve } from './server.js';
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
  const { values, positionals } = parseArgs({ options: { data: { type: 'string', default: process.env.RIFT_DATA_DIR || path.join(os.homedir(), '.local/share/rift') }, provider: { type: 'string', default: 'fake' } }, allowPositionals: true });
  if (!path.isAbsolute(values.data)) throw new Error('--data must be an absolute path shared by host and reviewer.');
  if (values.provider !== 'fake') throw new Error('This version supports --provider fake.');
  const operations = new Operations(values.data, new FakeCalendar(values.data));
  const [command, id] = positionals;
  if (command === 'serve') { await serve(operations); return; }
  try {
    const result = command === 'pending' ? operations.pending() : command === 'status' ? operations.get(id) : command === 'review' ? await review(operations, id) : command === 'reconcile' ? await operations.reconcile(id) : (() => { throw new Error('Commands: serve, pending, status ID, review ID, reconcile ID.'); })();
    console.log(JSON.stringify(result, null, 2));
  } finally { operations.close(); operations.provider.close?.(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Rift command failed. Check the command, state directory, provider and terminal requirements.'); process.exitCode = 1; });
