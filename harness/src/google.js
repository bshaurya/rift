import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
export function privateWrite(filename, value) {
  assertCredentialDirectory(path.dirname(filename));
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
export function assertCredentialDirectory(directory) {
  const requested = path.resolve(directory);
  let ancestor = requested;
  // Find the nearest existing ancestor without treating dangling links as missing.
  while (true) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const physical = fs.realpathSync(ancestor);
  for (let current of new Set([requested, physical])) {
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) throw new Error('Credentials must be stored outside a Git checkout.');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
}
export class GoogleCalendar {
  constructor({ auth, calendarId, fetchImpl = fetch }) {
    if (!calendarId || typeof calendarId !== 'string') throw new Error('A calendar account is required.');
    this.auth = auth; this.calendarId = calendarId; this.identity = `google:${calendarId}`; this.fetch = fetchImpl;
  }
  async request(route, { method = 'GET', body, signal } = {}) {
    let token;
    try { token = (await this.auth.getAccessToken()).token; if (!token) throw new Error('Missing token'); }
    catch { throw Object.assign(new Error('Calendar authentication required.'), { code: 401, beforeWrite: true, publicMessage: 'Google authentication failed. Run Rift auth locally, then restart the MCP client.' }); }
    if (signal?.aborted) throw Object.assign(new Error('Aborted before calendar request.'), { beforeWrite: true });
    const response = await this.fetch(`https://www.googleapis.com/calendar/v3${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      let rateLimited = response.status === 429;
      try {
        const data = await response.json();
        rateLimited ||= data.error?.errors?.some(error => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(error.reason)) === true;
      } catch {}
      throw Object.assign(new Error('Google Calendar rejected the request.'), { code: response.status, rateLimited });
    }
    return response.json();
  }
  async events({ timeMin, timeMax, timeZone }) {
    const events = []; let pageToken;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ timeMin, timeMax, timeZone, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '2500' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`);
      if (data.items && !Array.isArray(data.items)) throw new Error('Invalid calendar response.');
      events.push(...(data.items || []).map(({ id, summary, start, end, location, description }) => ({ id, summary, start, end, location, description })));
      pageToken = data.nextPageToken; if (!pageToken) return events;
    }
    throw new Error('Event query exceeded the page limit; use a smaller window.');
  }
  async busy({ timeMin, timeMax, timeZone }) {
    const data = await this.request('/freeBusy', { method: 'POST', body: { timeMin, timeMax, timeZone, items: [{ id: this.calendarId }] } });
    const calendar = data.calendars?.[this.calendarId];
    if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error('Calendar availability is unavailable.');
    return calendar.busy;
  }
  async create(action, id, signal) {
    // Native fetch performs no application-level retry or automatic auth replay.
    return this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events`, { method: 'POST', signal, body: {
      id, summary: action.title, start: { dateTime: action.start, timeZone: action.timeZone },
      end: { dateTime: action.end, timeZone: action.timeZone }, location: action.location, description: action.description
    } });
  }
  async find(id) {
    try {
      const event = await this.request(`/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`);
      return event.status === 'cancelled' ? null : event;
    } catch (error) { if (error.code === 404 || error.code === 410) return null; throw error; }
  }
}
export function loadGoogle(directory) {
  assertCredentialDirectory(directory);
  const filename = path.join(directory, 'google-credentials.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw Object.assign(new Error('Google credentials unavailable.'), { publicMessage: 'Google authentication is missing or unreadable. Run: node harness/src/cli.js auth --client /absolute/path/client.json --data /absolute/path/rift-state' }); }
  if (!config.clientId || !config.clientSecret || !config.tokens?.refresh_token || !config.calendarId) throw new Error('Run local Google authentication first.');
  const auth = new OAuth2Client(config.clientId, config.clientSecret);
  auth.setCredentials(config.tokens);
  auth.on('tokens', tokens => {
    config.tokens = { ...config.tokens, ...tokens };
    privateWrite(filename, config);
  });
  return new GoogleCalendar({ auth, calendarId: config.calendarId });
}
