import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleCalendar, privateWrite, assertCredentialDirectory } from '../src/google.js';
import { startLoopback } from '../src/auth.js';
const event = { title: 'Focus', start: '2026-10-05T14:00:00-04:00', end: '2026-10-05T14:30:00-04:00', timeZone: 'America/New_York', location: null, description: null };
const auth = { getAccessToken: async () => ({ token: 'fixture-token' }) };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
test('Google insertion uses operation ID, reviewed offsets/timezone, and one native request', async () => {
  const calls = []; const calendar = new GoogleCalendar({ auth, calendarId: 'fixture@example.test', fetchImpl: async (...args) => { calls.push(args); return response({ id: 'operation' }); } });
  assert.equal((await calendar.create(event, 'operation')).id, 'operation');
  const [url, options] = calls[0]; assert.match(url, /fixture%40example.test\/events$/);
  const body = JSON.parse(options.body); assert.equal(body.id, 'operation'); assert.equal(body.start.dateTime, event.start); assert.equal(body.start.timeZone, event.timeZone); assert.equal(options.method, 'POST'); assert.equal(calls.length, 1);
});
for (const status of [401, 403, 429, 500]) test(`Google ${status} has no automatic insertion retry`, async () => {
  let calls = 0; const calendar = new GoogleCalendar({ auth, calendarId: 'fixture', fetchImpl: async () => { calls++; return response({}, status); } });
  await assert.rejects(calendar.create(event, 'op'), error => error.code === status); assert.equal(calls, 1);
});
test('auth failure and aborted requests stop before insertion', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response({}); };
  const calendar = new GoogleCalendar({ auth: { getAccessToken: async () => { throw new Error('fixture-private-details'); } }, calendarId: 'fixture', fetchImpl });
  await assert.rejects(calendar.create(event, 'op'), error => error.beforeWrite && !error.message.includes('fixture-private-details'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(new GoogleCalendar({ auth, calendarId: 'fixture', fetchImpl }).create(event, 'op', aborted.signal), error => error.beforeWrite);
  assert.equal(calls, 0);
});
test('Google event reads paginate and availability errors do not imply free time', async () => {
  const urls = []; const calendar = new GoogleCalendar({ auth, calendarId: 'fixture', fetchImpl: async url => { urls.push(url); return response(url.includes('pageToken=second') ? { items: [{ id: 'b' }] } : { items: [{ id: 'a' }], nextPageToken: 'second' }); } });
  const events = await calendar.events({ timeMin: event.start, timeMax: event.end, timeZone: event.timeZone }); assert.deepEqual(events.map(e => e.id), ['a', 'b']); assert.equal(urls.length, 2);
  calendar.fetch = async () => response({ calendars: { fixture: { errors: [{ reason: 'notFound' }], busy: [] } } });
  await assert.rejects(calendar.busy({ timeMin: event.start, timeMax: event.end, timeZone: event.timeZone }));
});
test('reconciliation is GET-only; not-found and cancelled events remain absent', async () => {
  const methods = []; const calendar = new GoogleCalendar({ auth, calendarId: 'fixture', fetchImpl: async (_url, opts) => { methods.push(opts.method); return response({ id: 'op' }); } });
  assert.equal((await calendar.find('op')).id, 'op'); assert.deepEqual(methods, ['GET']);
  calendar.fetch = async () => response({}, 404); assert.equal(await calendar.find('op'), null);
  calendar.fetch = async () => response({ id: 'op', status: 'cancelled' }); assert.equal(await calendar.find('op'), null);
});
test('credential writes are private; repository directories are rejected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-auth-files-'));
  try {
    const filename = path.join(directory, 'google-credentials.json'); privateWrite(filename, { fixture: true });
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename)), { fixture: true });
    fs.mkdirSync(path.join(directory, '.git')); assert.throws(() => assertCredentialDirectory(path.join(directory, 'nested')), /outside a Git/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('credential guards resolve aliases and missing descendants before writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-auth-alias-'));
  try {
    const checkout = path.join(root, 'checkout'), state = path.join(checkout, 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: fixture');
    const unsafe = path.join(root, 'unsafe-alias');
    fs.symlinkSync(state, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
    for (const directory of [unsafe, path.join(unsafe, 'missing', 'nested')]) {
      assert.throws(() => assertCredentialDirectory(directory), /outside a Git/);
      assert.throws(() => privateWrite(path.join(directory, 'google-credentials.json'), { fixture: true }), /outside a Git/);
    }
    assert.equal(fs.existsSync(path.join(state, 'google-credentials.json')), false);
    assert.equal(fs.existsSync(path.join(state, 'missing')), false);
    const external = path.join(root, 'external'); fs.mkdirSync(external);
    const safe = path.join(root, 'safe-alias');
    fs.symlinkSync(external, safe, process.platform === 'win32' ? 'junction' : 'dir');
    const filename = path.join(safe, 'new', 'google-credentials.json');
    assertCredentialDirectory(path.dirname(filename));
    privateWrite(filename, { fixture: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(external, 'new', 'google-credentials.json'))), { fixture: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('dangling credential aliases fail closed without creating their destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-auth-dangling-'));
  try {
    const checkout = path.join(root, 'checkout'); fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const missing = path.join(checkout, 'missing'), alias = path.join(root, 'alias');
    fs.symlinkSync(missing, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertCredentialDirectory(path.join(alias, 'new')));
    assert.throws(() => privateWrite(path.join(alias, 'new', 'google-credentials.json'), { fixture: true }));
    assert.equal(fs.existsSync(missing), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
function fakeHttp() {
  let handler;
  return { get handler() { return handler; }, createServer(fn) { handler = fn; return { listen() {}, address: () => ({ port: 12345 }), once(name, cb) { if (name === 'listening') queueMicrotask(cb); return this; }, on() {}, removeListener() {}, close() {}, closeAllConnections() {} }; } };
}
function callback(url) { const result = { status: 200, body: '' }; return { result, request: { method: 'GET', url }, response: { writeHead(status) { result.status = status; }, end(body) { result.body = body; } } }; }
test('OAuth checks state, uses S256 PKCE and exchanges one callback without exposing tokens', async () => {
  const server = fakeHttp(); const exchanged = []; let options;
  const oauth = { generateCodeVerifierAsync: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }), generateAuthUrl: opts => { options = opts; return 'fixture-url'; }, getToken: async args => { exchanged.push(args); return { tokens: { refresh_token: 'fixture-refresh' } }; } };
  const flow = await startLoopback(oauth, { createServer: server.createServer });
  assert.equal(options.code_challenge_method, 'S256'); assert.equal(options.code_challenge, 'fixture-challenge'); assert.match(options.redirect_uri, /^http:\/\/127\.0\.0\.1:/);
  const wrong = callback('/oauth2callback?state=wrong&code=fixture-code'); await server.handler(wrong.request, wrong.response); assert.equal(wrong.result.status, 400); assert.equal(exchanged.length, 0);
  const valid = callback(`/oauth2callback?state=${options.state}&code=fixture-code`); await server.handler(valid.request, valid.response);
  assert.equal((await flow.completion).refresh_token, 'fixture-refresh'); assert.equal(exchanged[0].codeVerifier, 'fixture-verifier'); assert.equal(exchanged[0].redirect_uri, options.redirect_uri); assert.ok(!valid.result.body.includes('fixture-refresh'));
  await server.handler(valid.request, valid.response); assert.equal(exchanged.length, 1);
});
test('OAuth denial and timeout reject without credentials', async () => {
  const make = async (timeoutMs = 120000) => {
    const server = fakeHttp(); let options;
    const flow = await startLoopback({ generateCodeVerifierAsync: async () => ({}), generateAuthUrl: opts => { options = opts; return 'fixture'; } }, { createServer: server.createServer, timeoutMs });
    return { flow, server, options };
  };
  const denied = await make(); const cb = callback(`/oauth2callback?state=${denied.options.state}&error=access_denied`); await denied.server.handler(cb.request, cb.response); await assert.rejects(denied.flow.completion, /denied/);
  const timed = await make(5); await assert.rejects(timed.flow.completion, /timed out/);
});

test('Google quota rejection is classified without leaking provider response text', async () => {
  const calendar = new GoogleCalendar({ auth, calendarId: 'fixture', fetchImpl: async () => response({ error: { message: 'fixture-private-details', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403) });
  await assert.rejects(calendar.create(event, 'op'), error => error.rateLimited && !error.message.includes('fixture-private-details'));
});
