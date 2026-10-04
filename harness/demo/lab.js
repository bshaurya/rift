import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo } from '../src/lab/runner.js';
import { writeReport } from '../src/lab/report.js';

const root = fileURLToPath(new URL('../.lab-runs/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const parent = fs.mkdtempSync(path.join(root, 'demo-'));
const directory = path.join(parent, 'results');
const summary = await runDemo(directory);
const html = path.join(parent, 'report.html');
writeReport(directory, html);
console.log('Scripted action-client comparison (no model calls):');
for (const row of summary.results) console.log(`${row.scenario.padEnd(19)} ${row.client.padEnd(12)} ${row.outcome}`);
console.log(`Reports: ${directory}`);
console.log(`Open in your browser: ${html}`);
console.log(`Expected baseline failures and corrected outcomes verified: ${summary.verified}`);
if (!summary.verified) process.exitCode = 1;
