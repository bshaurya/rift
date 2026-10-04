import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import calendarGate from '../../app/src/calendar/gate.js';
const { validate } = calendarGate;
export const digestOf = action => createHash('sha256').update(JSON.stringify(action)).digest('hex');
export function validateRange({ timeMin, timeMax, timeZone }) {
  validate({ action: 'create', title: 'Range', start: timeMin, end: timeMax, timeZone, location: null, description: null, recurrence: null, attendees: [], ambiguities: [] });
  if (Date.parse(timeMax) - Date.parse(timeMin) > 31 * 86400000) throw new Error('Query windows must be at most 31 days.');
}
export function freeWindows(range, busy) {
  validateRange(range);
  const min = Date.parse(range.timeMin), max = Date.parse(range.timeMax);
  const intervals = busy.map(item => {
    const start = Date.parse(item.start), end = Date.parse(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Provider returned invalid availability; no slots can be trusted.');
    return [Math.max(start, min), Math.min(end, max)];
  }).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const windows = []; let cursor = min;
  for (const [start, end] of intervals) {
    if (start > cursor) windows.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
    cursor = Math.max(cursor, end);
  }
  if (cursor < max) windows.push({ start: new Date(cursor).toISOString(), end: new Date(max).toISOString() });
  return windows;
}
export class Operations {
  constructor(directory, provider, { now = Date.now, timeoutMs = 15000 } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.provider = provider; this.now = now; this.timeoutMs = timeoutMs;
    const filename = path.join(directory, 'operations.sqlite');
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, deadline INTEGER, reason TEXT, eventId TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS active_digest ON operations(digest)
        WHERE status IN ('proposed','executing','uncertain','succeeded');`);
    this.db.prepare('INSERT OR IGNORE INTO profile VALUES (1, ?)').run(provider.identity);
    if (this.db.prepare('SELECT identity FROM profile').get().identity !== provider.identity) {
      this.db.close(); throw new Error('This state directory belongs to another provider/account. Choose a different directory.');
    }
  }
  close() { this.db.close(); }
  recover() {
    const now = this.now();
    this.db.prepare("UPDATE operations SET status='uncertain', reason='Execution interrupted or timed out; reconcile before scheduling again.' WHERE status='executing' AND deadline<=?").run(now);
    this.db.prepare("UPDATE operations SET status='stale' WHERE status='proposed' AND expiresAt<=?").run(now);
  }
  get(id) {
    this.recover();
    const record = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    if (!record) throw new Error('Unknown operation ID.');
    return { ...record, action: JSON.parse(record.action), destination: this.provider.identity };
  }
  pending() {
    this.recover();
    return this.db.prepare("SELECT id FROM operations WHERE status IN ('proposed','executing','uncertain') ORDER BY createdAt DESC LIMIT 50").all().map(({ id }) => this.get(id));
  }
  async events(range) { validateRange(range); return this.provider.events(range); }
  async availability(range, durationMinutes = 30) {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) throw new Error('Duration must be 5–480 whole minutes.');
    const windows = freeWindows(range, await this.provider.busy(range));
    return { timeZone: range.timeZone, freeWindows: windows, suggestedSlots: windows.filter(w => Date.parse(w.end) - Date.parse(w.start) >= durationMinutes * 60000).slice(0, 20).map(w => ({ start: w.start, end: new Date(Date.parse(w.start) + durationMinutes * 60000).toISOString() })) };
  }
  async checkAvailable(action) {
    try {
      const windows = freeWindows({ timeMin: action.start, timeMax: action.end, timeZone: action.timeZone }, await this.provider.busy({ timeMin: action.start, timeMax: action.end, timeZone: action.timeZone }));
      if (windows.length !== 1 || Date.parse(windows[0].start) !== Date.parse(action.start) || Date.parse(windows[0].end) !== Date.parse(action.end)) throw Object.assign(new Error('The proposed time overlaps a busy event. Choose another time.'), { publicMessage: 'The proposed time overlaps a busy event. Read availability and choose another time.' });
    } catch (error) { error.beforeWrite = true; throw error; }
  }
  async propose(value) {
    let action;
    try { action = validate(value); }
    catch (error) { error.publicMessage = error.message; throw error; }
    const digest = digestOf(action);
    this.recover();
    const existing = this.db.prepare("SELECT id FROM operations WHERE digest=? AND status IN ('proposed','executing','uncertain','succeeded')").get(digest);
    if (existing) return { ...this.get(existing.id), reused: true };
    await this.checkAvailable(action);
    const id = randomUUID(), now = this.now();
    // Unique active digest also deduplicates proposals racing from different clients.
    this.db.prepare("INSERT OR IGNORE INTO operations (id,action,digest,status,createdAt,expiresAt) VALUES (?,?,?,'proposed',?,?)").run(id, JSON.stringify(action), digest, now, now + 600000);
    const actual = this.db.prepare("SELECT id FROM operations WHERE digest=? AND status IN ('proposed','executing','uncertain','succeeded')").get(digest);
    return this.get(actual.id);
  }
  cancel(id) {
    this.get(id);
    this.db.prepare("UPDATE operations SET status='cancelled' WHERE id=? AND status='proposed'").run(id);
    return this.get(id);
  }
  async approve(id, digest) {
    const record = this.get(id);
    if (digest !== record.digest || digestOf(validate(record.action)) !== digest) throw new Error('Altered proposal.');
    const claim = this.db.prepare("UPDATE operations SET status='executing', deadline=? WHERE id=? AND digest=? AND status='proposed' AND expiresAt>?").run(this.now() + this.timeoutMs, id, digest, this.now());
    if (claim.changes !== 1) return this.get(id);
    let timer, insertionStarted = false;
    const controller = new AbortController();
    try {
      const event = await Promise.race([
        (async () => {
          await this.checkAvailable(record.action);
          controller.signal.throwIfAborted();
          insertionStarted = true;
          return this.provider.create(record.action, id.replaceAll('-', ''), controller.signal);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Execution timed out'), { beforeWrite: !insertionStarted })); }, this.timeoutMs); })
      ]);
      if (!event?.id) throw new Error('Provider did not acknowledge an event ID.');
      this.db.prepare("UPDATE operations SET status='succeeded', eventId=?, reason=NULL WHERE id=? AND status IN ('executing','uncertain')").run(event.id, id);
    } catch (error) {
      const code = Number(error.response?.status || error.code);
      const known = error.beforeWrite || [400, 401, 403, 404, 422, 429].includes(code);
      const reason = code === 429 || error.rateLimited ? 'rate-limit' : [401, 403].includes(code) ? 'auth' : known ? 'rejected-before-or-by-provider' : 'Outcome uncertain. Reconcile before scheduling again.';
      this.db.prepare("UPDATE operations SET status=?, reason=? WHERE id=? AND status IN ('executing','uncertain')").run(known ? 'failed' : 'uncertain', reason, id);
    } finally { clearTimeout(timer); }
    return this.get(id);
  }
  async reconcile(id) {
    const record = this.get(id);
    if (record.status !== 'uncertain') return record;
    const event = await this.provider.find(id.replaceAll('-', ''));
    if (event?.id) this.db.prepare("UPDATE operations SET status='succeeded', eventId=?, reason='Reconciled by provider read' WHERE id=? AND status='uncertain'").run(event.id, id);
    // Not-found is not proof a timed-out insertion can never complete. Never retry.
    return this.get(id);
  }
}
