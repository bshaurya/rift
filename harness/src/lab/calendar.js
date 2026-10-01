import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { actionSchema, eventIdSchema, rangeSchema, scenarioSchema } from './schema.js';

export const LAB_DATABASE = 'lab-calendar.sqlite';
const timeoutMessage = 'Calendar request timed out. The outcome is unknown; inspect the calendar before trying again.';
const providerEvent = (action, id) => ({
  id, summary: action.title,
  start: { dateTime: action.start, timeZone: action.timeZone },
  end: { dateTime: action.end, timeZone: action.timeZone },
  location: action.location, description: action.description
});
const errorRecord = (code, message) => ({ code, message });
function publicError(record) {
  return Object.assign(new Error(record.message), { code: record.code, publicMessage: record.message });
}
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw publicError(errorRecord(400, `Invalid calendar arguments: ${parsed.error.issues.map(issue => issue.message).join(' ')}`));
  return parsed.data;
}
function configure(db) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
}

export class ScenarioCalendar {
  #db;
  #scenario;

  static initialize(directory, value) {
    // Reject invalid scenarios before making either a directory or a database.
    const scenario = scenarioSchema.parse(value);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, LAB_DATABASE);
    const fd = fs.openSync(filename, 'wx', 0o600);
    fs.closeSync(fd);
    let db, inTransaction = false;
    try {
      db = new DatabaseSync(filename);
      configure(db);
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE events (id TEXT PRIMARY KEY, event TEXT NOT NULL);
        CREATE TABLE counters (method TEXT PRIMARY KEY, invocation INTEGER NOT NULL);
        CREATE TABLE faults (faultIndex INTEGER PRIMARY KEY, consumed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE trace (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL);`);
      const put = db.prepare('INSERT INTO metadata VALUES (?,?)');
      put.run('scenario', JSON.stringify(scenario));
      put.run('identity', `lab:${randomUUID()}`);
      const insert = db.prepare('INSERT INTO events VALUES (?,?)');
      for (const fixture of scenario.initialEvents) insert.run(fixture.id, JSON.stringify(providerEvent(fixture.action, fixture.id)));
      const fault = db.prepare('INSERT INTO faults (faultIndex) VALUES (?)');
      scenario.faults.forEach((_value, index) => fault.run(index));
      db.exec('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) db.exec('ROLLBACK');
      db?.close();
      db = null;
      // This process exclusively created this file; failed initialization is not a run.
      fs.unlinkSync(filename);
      throw error;
    } finally { db?.close(); }
  }

  constructor(directory) {
    const filename = path.join(directory, LAB_DATABASE);
    if (!fs.lstatSync(filename).isFile()) throw new Error('A lab database file is required. Initialize a new run first.');
    const db = new DatabaseSync(filename);
    try {
      configure(db);
      const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, row.value]));
      this.#scenario = scenarioSchema.parse(JSON.parse(metadata.scenario));
      if (!/^lab:[0-9a-f-]{36}$/.test(metadata.identity)) throw new Error('Invalid lab identity.');
      this.identity = metadata.identity;
      this.#db = db;
    } catch (error) { db.close(); throw error; }
  }

  get scenario() { return structuredClone(this.#scenario); }
  close() { this.#db?.close(); this.#db = null; }
  snapshot() { return this.#db.prepare('SELECT event FROM events ORDER BY id').all().map(row => JSON.parse(row.event)); }
  trace() { return this.#db.prepare('SELECT sequence,record FROM trace ORDER BY sequence').all().map(row => ({ sequence: row.sequence, ...JSON.parse(row.record) })); }
  inspect() {
    this.#db.exec('BEGIN');
    try {
      const inspection = { scenario: this.scenario, trace: this.trace(), events: this.snapshot() };
      this.#db.exec('COMMIT');
      return inspection;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  #invoke(method, args) {
    const db = this.#db;
    let result, error, inTransaction = false;
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const before = this.snapshot();
      db.prepare('INSERT INTO counters (method,invocation) VALUES (?,1) ON CONFLICT(method) DO UPDATE SET invocation=invocation+1').run(method);
      const { invocation } = db.prepare('SELECT invocation FROM counters WHERE method=?').get(method);
      const faultIndex = this.#scenario.faults.findIndex(fault => fault.method === method && fault.invocation === invocation);
      let fault;
      if (faultIndex !== -1) {
        const claimed = db.prepare('UPDATE faults SET consumed=1 WHERE faultIndex=? AND consumed=0').run(faultIndex);
        if (claimed.changes !== 1) throw new Error('Fault state is inconsistent.');
        fault = this.#scenario.faults[faultIndex];
      }

      if (fault?.effect === 'timeout_before') error = errorRecord('ETIMEDOUT', timeoutMessage);
      else if (fault?.effect === 'reject_auth') error = errorRecord(401, 'Calendar authentication required.');
      else if (fault?.effect === 'reject_rate_limit') error = errorRecord(429, 'Calendar rate limit exceeded.');
      else if (method === 'events') {
        result = before.filter(event => Date.parse(event.end.dateTime) > Date.parse(args.timeMin) && Date.parse(event.start.dateTime) < Date.parse(args.timeMax));
        if (fault?.effect === 'insert_after_read') {
          const event = providerEvent(fault.event.action, fault.event.id);
          db.prepare('INSERT INTO events VALUES (?,?)').run(event.id, JSON.stringify(event));
        }
      } else if (method === 'find') result = before.find(event => event.id === args.id) ?? null;
      else {
        if (before.some(event => event.id === args.id)) error = errorRecord(409, 'A calendar event with this ID already exists.');
        else {
          const event = providerEvent(args.action, args.id);
          db.prepare('INSERT INTO events VALUES (?,?)').run(event.id, JSON.stringify(event));
          if (fault?.effect === 'commit_then_timeout') error = errorRecord('ETIMEDOUT', timeoutMessage);
          else result = fault?.effect === 'malformed_ack' ? {} : event;
        }
      }

      const record = { method, invocation, args, before, after: this.snapshot() };
      if (error !== undefined) record.error = error;
      else record.result = result;
      if (fault !== undefined) record.faultIndex = faultIndex;
      db.prepare('INSERT INTO trace (record) VALUES (?)').run(JSON.stringify(record));
      db.exec('COMMIT');
      inTransaction = false;
    } catch (cause) {
      if (inTransaction) db.exec('ROLLBACK');
      throw Object.assign(new Error('The offline calendar transaction failed.'), { code: 'LAB_TRANSACTION', publicMessage: 'The offline calendar transaction failed.', cause });
    }
    // Provider errors are delivered only after state, fault consumption and trace commit.
    if (error !== undefined) throw publicError(error);
    return structuredClone(result);
  }

  // Invalid arguments do not consume fault slots or create provider-call trace entries.
  async events(range) { return this.#invoke('events', parse(rangeSchema, range)); }
  async busy(range) { return (await this.events(range)).map(event => ({ start: event.start.dateTime, end: event.end.dateTime })); }
  async create(action, id) { return this.#invoke('create', { action: parse(actionSchema, action), id: parse(eventIdSchema, id) }); }
  async find(id) { return this.#invoke('find', { id: parse(eventIdSchema, id) }); }
}
