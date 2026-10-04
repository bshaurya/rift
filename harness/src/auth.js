import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { OAuth2Client } from 'google-auth-library';
import { assertCredentialDirectory, privateWrite, GoogleCalendar } from './google.js';
export async function startLoopback(oauth, { timeoutMs = 120000, createServer = http.createServer } = {}) {
  const state = randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  let complete, fail, finished = false, exchanging = false, timer;
  const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // The CLI prints the URL before awaiting completion, so suppress premature unhandled rejection.
  completion.catch(() => {});
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) {
      response.writeHead(400); response.end('Invalid authentication callback.'); return;
    }
    if (finished || exchanging) { response.writeHead(409); response.end('Callback already handled.'); return; }
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      finished = true; response.writeHead(400); response.end('Authentication denied. Return to your terminal.'); clearTimeout(timer); server.close(); fail(new Error('Authentication denied.')); return;
    }
    exchanging = true;
    try {
      const { tokens } = await oauth.getToken({ code: url.searchParams.get('code'), codeVerifier, redirect_uri: redirect });
      if (finished) { response.writeHead(408); response.end('Authentication expired.'); return; }
      if (!tokens?.refresh_token) throw new Error('Offline access is required.');
      finished = true; response.end('Authentication complete. Close this page and return to your terminal.'); complete(tokens);
    } catch {
      finished = true; response.writeHead(400); response.end('Authentication failed. Return to your terminal.'); fail(new Error('Authentication failed.'));
    } finally { clearTimeout(timer); server.close(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const url = oauth.generateAuthUrl({ redirect_uri: redirect, access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'], state, code_challenge: codeChallenge, code_challenge_method: 'S256' });
  timer = setTimeout(() => { finished = true; server.closeAllConnections(); server.close(); fail(new Error('Authentication timed out.')); }, timeoutMs);
  return { url, completion, close() { finished = true; clearTimeout(timer); server.closeAllConnections(); server.close(); fail(new Error('Authentication cancelled.')); } };
}
export async function authenticate(directory, clientFilename, print = console.log) {
  assertCredentialDirectory(directory);
  if (!clientFilename || !path.isAbsolute(clientFilename)) throw new Error('Use --client with an absolute Desktop OAuth client JSON path.');
  const client = JSON.parse(fs.readFileSync(clientFilename, 'utf8')).installed;
  if (!client?.client_id || !client?.client_secret) throw new Error('Use a Google Desktop OAuth client.');
  const oauth = new OAuth2Client(client.client_id, client.client_secret);
  const flow = await startLoopback(oauth);
  print(`Open this Google authorization URL in your browser:\n${flow.url}`);
  const tokens = await flow.completion;
  oauth.setCredentials(tokens);
  const metadata = await new GoogleCalendar({ auth: oauth, calendarId: 'primary' }).request('/calendars/primary');
  if (!metadata.id) throw new Error('Could not identify the primary calendar.');
  // Never replace a profile's account while it has reviewed operations.
  const filename = path.join(directory, 'google-credentials.json');
  if (fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).calendarId !== metadata.id) throw new Error('Use a separate state directory for another Google account.');
  privateWrite(filename, { clientId: client.client_id, clientSecret: client.client_secret, tokens, calendarId: metadata.id });
  print('Google Calendar authentication saved locally. No event was created.');
}
