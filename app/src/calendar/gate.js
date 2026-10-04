const { randomUUID, createHash } = require('node:crypto');

const fields = ['action', 'title', 'start', 'end', 'timeZone', 'location', 'description', 'recurrence', 'attendees', 'ambiguities'];
function validate(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) {
    throw new Error('Expected exactly the calendar proposal schema fields.');
  }
  if (value.action !== 'create' || value.recurrence !== null ||
      !Array.isArray(value.attendees) || value.attendees.length) {
    throw new Error('Only one nonrecurring event without attendees is supported.');
  }
  if (!Array.isArray(value.ambiguities) || value.ambiguities.length) {
    throw new Error('Clarify the date, start, end, and timezone before proposing an event.');
  }
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) throw new Error('A title is required (maximum 200 characters).');
  for (const key of ['location', 'description']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 2000)) throw new Error(`Invalid ${key}.`);
  }
  if (typeof value.timeZone !== 'string') throw new Error('An explicit IANA timezone is required.');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { throw new Error('Invalid IANA timezone.'); }
  for (const key of ['start', 'end']) {
    const match = typeof value[key] === 'string' && value[key].match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/);
    if (!match || !Number.isFinite(Date.parse(value[key]))) throw new Error('Use valid RFC3339 times with explicit offsets.');
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value[key])).map(p => [p.type, p.value]));
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].some((part, i) => parts[part] !== match[i + 1])) {
      throw new Error('Date or offset does not match the timezone (including daylight saving time).');
    }
  }
  if (Date.parse(value.end) <= Date.parse(value.start)) throw new Error('End must be after start.');
  return Object.fromEntries(fields.map(k => [k, structuredClone(value[k])]));
}

function parseModel(text) {
  if (typeof text !== 'string' || text.length > 16000) throw new Error('Invalid model response.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Model must return only a JSON object.'); }
  return validate(value);
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

class CalendarGate {
  constructor({ model, calendar, store, now = Date.now, timeoutMs = 15000 }) {
    this.model = model; this.calendar = calendar; this.store = store; this.now = now; this.timeoutMs = timeoutMs;
    this.records = store.load();
    for (const record of Object.values(this.records)) {
      if (record.status === 'executing') record.status = 'uncertain';
      else if (record.status === 'proposed') record.status = 'stale';
    }
    store.save(this.records);
  }
  async propose(request) {
    if (typeof request !== 'string' || !request.trim() || request.length > 4000) throw new Error('Provide a request up to 4000 characters.');
    const action = parseModel(await this.model(request));
    const destination = await this.calendar.destination();
    if (typeof destination !== 'string' || !destination.trim() || destination.length > 1024) throw new Error('A concrete calendar destination is required.');
    const operationId = randomUUID();
    const record = { operationId, action, destination, digest: fingerprint({ action, destination }), status: 'proposed', expiresAt: this.now() + 10 * 60 * 1000 };
    this.records[operationId] = record;
    this.store.save(this.records);
    return structuredClone(record);
  }
  get(operationId) { return structuredClone(this.records[operationId] || null); }
  cancel(operationId, digest) {
    const record = this.checked(operationId, digest);
    if (record.status === 'proposed') {
      record.status = 'cancelled'; this.store.save(this.records);
    }
    return this.get(operationId);
  }
  checked(operationId, digest) {
    const record = this.records[operationId];
    if (!record || record.digest !== digest || fingerprint({ action: record.action, destination: record.destination }) !== digest) throw new Error('Unknown or altered proposal.');
    validate(record.action);
    return record;
  }
  async confirm(operationId, digest) {
    const record = this.checked(operationId, digest);
    if (record.status !== 'proposed') return this.get(operationId);
    if (this.now() >= record.expiresAt) {
      record.status = 'stale'; this.store.save(this.records); return this.get(operationId);
    }
    // Persist before the first await: concurrent confirmations cannot issue a second write.
    record.status = 'executing';
    this.store.save(this.records);
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.calendar.create(record.action, operationId, record.destination)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); })
      ]);
      if (result?.id !== operationId.replaceAll('-', '')) throw new Error('Provider did not acknowledge the requested event ID.');
      record.status = 'succeeded';
      record.eventId = result.id;
    } catch (error) {
      const status = Number(error.response?.status || error.code);
      const known = error.beforeWrite === true || [400, 401, 403, 404, 422, 429].includes(status);
      record.status = known ? 'failed' : 'uncertain';
      record.reason = error.destinationChanged ? 'destination-changed' : status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : known ? 'provider-rejected' : 'Check the calendar before making another proposal; the event may exist.';
    } finally { clearTimeout(timer); }
    this.store.save(this.records);
    return this.get(operationId);
  }
}
module.exports = { CalendarGate, validate, parseModel };
