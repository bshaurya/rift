import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class FakeCalendar {
  constructor(directory) {
    this.identity = 'fake:primary';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, 'fake-calendar.sqlite');
    this.db = new DatabaseSync(filename); fs.chmodSync(filename, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, event TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run('fixture', JSON.stringify({ id: 'fixture', summary: 'Existing meeting', start: { dateTime: '2026-10-05T13:00:00-04:00' }, end: { dateTime: '2026-10-05T14:00:00-04:00' } }));
  }
  close() { this.db.close(); }
  all() { return this.db.prepare('SELECT event FROM events').all().map(row => JSON.parse(row.event)); }
  async events(range) { return this.all().filter(e => Date.parse(e.end.dateTime) > Date.parse(range.timeMin) && Date.parse(e.start.dateTime) < Date.parse(range.timeMax)); }
  async busy(range) { return (await this.events(range)).map(e => ({ start: e.start.dateTime, end: e.end.dateTime })); }
  async create(action, id) {
    const event = { id, summary: action.title, start: { dateTime: action.start, timeZone: action.timeZone }, end: { dateTime: action.end, timeZone: action.timeZone }, location: action.location, description: action.description };
    this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?)').run(id, JSON.stringify(event));
    return this.find(id);
  }
  async find(id) { const row = this.db.prepare('SELECT event FROM events WHERE id=?').get(id); return row ? JSON.parse(row.event) : null; }
}
