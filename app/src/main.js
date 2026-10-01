const path = require('path');
const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
if (app && app.isPackaged){
  require('dotenv').config({ path: path.join(process.resourcesPath, '.env') });
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}
else {
  require('dotenv').config();
}
const isDev = !app || !app.isPackaged;
const { ensureAuth, getAuthUrl, handleOAuthCallback } = require('./calendar/google');
const { createCalendarService } = require('./calendar/service');
let calendarService;
const getCalendarService = () => calendarService ||= createCalendarService(path.join(app.getPath('userData'), 'calendar-operations.json'));
if (!app.requestSingleInstanceLock()) app.quit();
const { google } = require('googleapis');
const emailFunctions = require('./email/email');
const emailHandlers = require('./email/email-handlers');

console.log('[main] Environment check:', {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'Present' : 'Missing',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'Present' : 'Missing',
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? 'Present' : 'Missing',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'Present' : 'Missing',
  isPackaged: app ? app.isPackaged : false
});

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'utils/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, 'ui/index.html'));
  win.hide();
}

app.whenReady().then(async () => {
  createWindow();
  
  try {
    console.log('[main] Checking Google API key:', process.env.GOOGLE_API_KEY ? 'Present' : 'Missing');
    
    const { validateAndRefreshAuth, getAuthUrl } = require('./calendar/google');
    const isValid = await validateAndRefreshAuth();
    if (!isValid) {
      console.log('[main] Auth validation failed, will prompt for re-auth when needed');
      try {
        const { clearTokensAndAuth } = require('./utils/authHelper');
        await clearTokensAndAuth('rift-google-calendar', shell);
        console.log('[main] Cleared stored credentials and triggered re-auth');
      } catch (e) {
        console.error('[main] Failed to clear credentials:', e);
      }
    }
    else {
      console.log('[main] Auth validation successful');
    }
    
    try {
      const { validateEmailAuth, getEmailAuthUrl } = require('./email/email');
      const isEmailValid = await validateEmailAuth();
      if (!isEmailValid) {
        console.log('[main] Email auth validation failed, will prompt for re-auth when needed');
        const { clearTokensAndAuth } = require('./utils/authHelper');
        await clearTokensAndAuth('rift-google-email', shell);
      }
    } catch (e) {
      console.error('[main] Error checking email auth:', e);
    }
    
    try {
      const { validateAndRefreshAuth } = require('./spotify/spotify');
      const isSpotifyValid = await validateAndRefreshAuth();
      if (!isSpotifyValid) {
        console.log('[main] Spotify auth validation failed, will prompt for re-auth when needed');
        const { clearTokensAndAuth } = require('./utils/authHelper');
        await clearTokensAndAuth('rift-spotify', shell);
        
        console.log('[main] Spotify auth will be requested when needed');
      } else {
        console.log('[main] Spotify auth validation successful');
      }
    } catch (e) {
      console.error('[main] Error checking Spotify auth:', e);
    }
  }
  catch (err) {
    console.error('[main] Error validating auth on startup:', err);
  }
  
  setupEmailHandlers();
  
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.center();
      win.show();
      win.focus();
      win.webContents.send('focus-input');
    }
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (win && !win.isDestroyed()) {
    win.center();
    win.show();
    win.focus();
    win.webContents.send('focus-input');
  }
});

function isCalendarQuery(prompt) {
  return /\b(what|when|show|list|do i have|upcoming|next|today|tomorrow|this|week|month|schedule|events?|calendar|meetings?|appointments?|on my calendar|my schedule)\b/i.test(prompt) && 
         !/\b(add|create|schedule|set up|make|new)\b/i.test(prompt.substring(0, 20));
}

async function queryCalendar(prompt) {
  try {
    const { ensureAuth } = require('./calendar/google');
    const auth = await ensureAuth(win);
    
    const calendar = google.calendar({ 
      version: 'v3', 
      auth: auth,
      key: process.env.GOOGLE_API_KEY
    });
    
    const now = new Date();
    let timeMin = now.toISOString();
    let timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const dateWord = extractDateFromPrompt(prompt);
    if (dateWord) {
      let target = new Date();
      if (dateWord === 'tomorrow') target.setDate(target.getDate() + 1);
      else if (dateWord === 'today') {}
      else if (/\d{4}-\d{2}-\d{2}/.test(dateWord)) target = new Date(dateWord);
      else {
        const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        const idx = days.indexOf(dateWord);
        if (idx !== -1) {
          const nowIdx = target.getDay();
          let diff = idx - nowIdx;
          if (diff <= 0) diff += 7;
          target.setDate(target.getDate() + diff);
        }
      }
      timeMin = new Date(target.setHours(0,0,0,0)).toISOString();
      timeMax = new Date(target.setHours(23,59,59,999)).toISOString();
    }
    
    console.log(`[main] Querying calendar from ${timeMin} to ${timeMax}`);
    
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10
    });
    
    const events = eventsRes.data.items || [];
    if (events.length === 0) return 'No events found.';
    
    if (process.env.GEMINI_API_KEY && events.length > 0) {
      try {
        const axios = require('axios');
        const eventsText = events.map(ev => {
          const start = ev.start.dateTime || ev.start.date;
          const startDate = new Date(start);
          const timeStr = startDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          const dateStr = startDate.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
          return `Event: ${ev.summary}, Date: ${dateStr}, Time: ${timeStr}, Location: ${ev.location || 'Not specified'}`;
        }).join('\n');
        
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
        const geminiPrompt = `
        Based on the user's query: "${prompt}"
        
        Format these calendar events in a clear, organized way:
        ${eventsText}
        
        Group by date if appropriate. Include all relevant details like time, date, and location.
        Be concise but informative. Format the response to be easily readable.
        `;
        
        const body = {
          contents: [{ parts: [{ text: geminiPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            topP: 0.95,
            topK: 40
          }
        };
        
        const resp = await axios.post(url, body, { timeout: 5000 });
        const text = resp.data.candidates[0].content.parts[0].text.trim();
        return text;
      }
      catch (err) {
        console.error('[main] Error using Gemini for calendar formatting:', err);
      }
    }
    
    return events.map(ev => {
      const start = ev.start.dateTime || ev.start.date;
      const startDate = new Date(start);
      const timeStr = startDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const dateStr = startDate.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
      return `${dateStr} at ${timeStr}: ${ev.summary}${ev.location ? ' ('+ev.location+')' : ''}`;
    }).join('\n');
  }
  catch (err) {
    console.error('[main] Error querying calendar:', err);
    if (err.message === 'auth required') {
      const { getAuthUrl } = require('./calendar/google');
      const authUrl = await getAuthUrl();
      shell.openExternal(authUrl);
      return 'Authentication required. Please check your browser to complete the sign-in process.';
    }

    return `Error: ${err.message}`;
  }
}

function setupEmailHandlers() {
  const emailViewer = require('./email/emailViewer');
  emailViewer.setupEmailViewerHandlers(emailFunctions);
  
  try {
    ipcMain.removeHandler('start-email-auth');
  } catch (e) {}
  
  ipcMain.handle('start-email-auth', async () => {
    try {
      const url = await emailFunctions.getEmailAuthUrl();
      shell.openExternal(url);
      return true;
    } catch (err) {
      console.error('[main] Error starting email auth:', err);
      return { success: false, error: err.message };
    }
  });

  try {
    ipcMain.removeHandler('email-oauth-callback');
  } catch (e) {}
  
  ipcMain.handle('email-oauth-callback', async (event, code) => {
    try {
      await emailFunctions.handleEmailOAuthCallback(code);
      return { success: true };
    }
    catch (err) {
      console.error('[main] Error in email OAuth callback:', err);
      return { success: false, error: err.message };
    }
  });

  try {
    ipcMain.removeHandler('get-unread-emails');
  } catch (e) {}
  
  ipcMain.handle('get-unread-emails', async () => {
    try {
      await emailFunctions.ensureEmailAuth(win);
      const result = await emailFunctions.getUnreadEmails();
      return result;
    }
    catch (err) {
      console.error('[main] Error getting unread emails:', err);
      if (err.message === 'auth required') {
        try {
          const url = await emailFunctions.getEmailAuthUrl();
          shell.openExternal(url);
          return { error: 'Authentication required. Please check your browser to complete the sign-in process.' };
        } catch (authErr) {
          console.error('[main] Error getting email auth URL:', authErr);
          return { error: 'Failed to start authentication: ' + authErr.message };
        }
      }
      return { error: err.message };
    }
  });

  try {
    ipcMain.removeHandler('get-email-content');
  } catch (e) {}
  
  ipcMain.handle('get-email-content', async (event, messageId) => {
    try {
      await emailFunctions.ensureEmailAuth(win);
      const result = await emailFunctions.getEmailContent(messageId);
      return result;
    }
    catch (err) {
      console.error('[main] Error getting email content:', err);
      if (err.message === 'auth required') {
        try {
          const url = await emailFunctions.getEmailAuthUrl();
          shell.openExternal(url);
          return { error: 'Authentication required. Please check your browser to complete the sign-in process.' };
        }
        catch (authErr) {
          console.error('[main] Error getting email auth URL:', authErr);
          return { error: 'Failed to start authentication: ' + authErr.message };
        }
      }
      return { error: err.message };
    }
  });

  try {
    ipcMain.removeHandler('save-draft');
  } catch (e) {}
  
  ipcMain.handle('save-draft', async (event, draft) => {
    emailHandlers.currentDraft = draft;
    return { success: true };
  });

  try {
    ipcMain.removeHandler('send-draft');
  } catch (e) {}
  
  ipcMain.handle('send-draft', async () => {
    try {
      if (!emailHandlers.currentDraft) {
        throw new Error('No draft email to send');
      }
      
      await emailFunctions.ensureEmailAuth(win);
      const result = await emailFunctions.sendEmail(emailHandlers.currentDraft);
      emailHandlers.currentDraft = null;
      return { success: true, result };
    }
    catch (err) {
      console.error('[main] Error sending email:', err);
      if (err.message === 'auth required') {
        try {
          const url = await emailFunctions.getEmailAuthUrl();
          shell.openExternal(url);
          return { error: 'Authentication required. Please check your browser to complete the sign-in process.' };
        }
        catch (authErr) {
          console.error('[main] Error getting email auth URL:', authErr);
          return { error: 'Failed to start authentication: ' + authErr.message };
        }
      }
      return { error: err.message };
    }
  });

  try {
    ipcMain.removeHandler('store-history');
  } catch (e) {}
  
  ipcMain.handle('store-history', (event, prompt, response) => {
    emailHandlers.storePromptInHistory(prompt, response);
    return { success: true };
  });

  try {
    ipcMain.removeHandler('get-history');
  } catch (e) {}
  
  ipcMain.handle('get-history', () => {
    return emailHandlers.getPromptHistory();
  });
}

ipcMain.handle('route-prompt', async (event, prompt) => {
  try {
    const { ensureAuth, getAuthUrl, validateAndRefreshAuth } = require('./calendar/google');
    const { detectIntent } = require('./utils/intentDetector');
    // Explicit MVP commands avoid probabilistic intent/workflow routing.
    if (/^(create|add|schedule)\s+(?:(?:a|an|single)\s+)?(?:calendar\s+)?event\b/i.test(prompt.trim())) return await getCalendarService().propose(prompt);
    if (/^(delete|remove|cancel|modify|change|update)\b/i.test(prompt.trim()) && /\b(calendar|event|meeting|appointment)\b/i.test(prompt)) return { type: 'error', error: 'This calendar write is blocked in the single-event reliability MVP.' };
    if (/\b(create|make|set up|schedule)\s+(a\s+)?(google\s+)?meet\b/i.test(prompt)) {
      return { type: 'error', error: 'Google Meet calendar writes are blocked in the single-event reliability MVP.' };
    }
    
    const handlers = {
      email: emailHandlers,
      emailFunctions,
      drive: require('./drive/drive-handlers'),
      docs: require('./docs/docs-handlers'),
      meet: require('./meet/meet-handlers'),
      shell,
      win
    };
    
    const workflowManager = require('./utils/workflowManager');
    if (!/\b(spotify|music|song|play|pause|resume|next|previous|skip|playlist)\b/i.test(prompt)) {
      const workflow = await workflowManager.detectWorkflow(prompt);
      if (workflow && workflow.isWorkflow) {
        if (['CALENDAR_AND_DOCS', 'MEET_AND_EMAIL', 'CUSTOM'].includes(workflow.workflowType)) return { type: 'error', error: 'Calendar and custom workflows are blocked in the single-event reliability MVP.' };
        console.log(`[main] Detected workflow: ${workflow.workflowType}`);
        if (workflow.workflowType === 'MEET_AND_EMAIL' || (workflow.workflowType === 'CUSTOM' && /\b(meet|meeting)\b/i.test(prompt))) {
          console.log('[main] Using meet handler directly for workflow');
          return await handlers.meet.handleCreateMeeting(prompt, shell, win);
        }
        else {
          return await workflowManager.handleWorkflow(workflow.workflowType, prompt, handlers);
        }
      }
    }
    
    let followUpMode = null;
    let followUpType = null;
    if (prompt.includes('FOLLOW_UP_MODE:')) {
      const match = prompt.match(/FOLLOW_UP_MODE:\s*([\w-]+)/i);
      if (match) {
        followUpMode = match[1];
        console.log(`[main] Detected follow-up mode: ${followUpMode}`);
      }
      
      const typeMatch = prompt.match(/FOLLOW_UP_TYPE:\s*([\w-]+)/i);
      if (typeMatch) {
        followUpType = typeMatch[1];
        console.log(`[main] Detected follow-up type: ${followUpType}`);
      }
    }
    
    if (followUpMode) {
      const newPrompt = prompt.includes('NEW_PROMPT:') ? 
        prompt.split('NEW_PROMPT:')[1].trim() : prompt;
      
      if (followUpType === 'spotify-playlist-selection') {
        console.log('[main] Handling Spotify playlist selection in follow-up mode');
        const spotifyHandlers = require('./spotify/spotify-handlers');
        return await spotifyHandlers.handlePlayFromPlaylist(newPrompt, shell, win);
      }
      
      if (followUpType === 'email-edit') {
        console.log('[main] Handling email edit in follow-up mode');
        const result = await emailHandlers.updateDraftEmail(newPrompt);
        return result;
      }
    }
    
    const intent = await detectIntent(prompt);
    console.log(`[main] Detected intent: ${intent} for prompt: "${prompt}"`);
    if (intent === 'CALENDAR_CREATE') return await getCalendarService().propose(prompt);
    if (['CALENDAR_DELETE', 'CALENDAR_MODIFY', 'MEET_CREATE', 'MEET_SHARE'].includes(intent)) return { type: 'error', error: 'This calendar write is blocked in the single-event reliability MVP.' };
    
    if (global.lastEmailSearchResults && /\b(open|view|show|read)\s+(email|mail|message)\s+#?(\d+)\b/i.test(prompt)) {
      const match = prompt.match(/\b(open|view|show|read)\s+(email|mail|message)\s+#?(\d+)\b/i);
      if (match) {
        const emailNumber = parseInt(match[3]);
        if (emailNumber > 0 && emailNumber <= global.lastEmailSearchResults.length) {
          const email = global.lastEmailSearchResults[emailNumber - 1];
          const emailContent = await emailFunctions.getEmailContent(email.id);
          
          let responseAnalysis = '';
          try {
            const analysis = await emailFunctions.analyzeEmailForResponse(emailContent);
            if (analysis) {
              emailContent.suggestedResponse = analysis;
            }
          } catch (err) {
            console.error('[main] Error analyzing email for response:', err);
          }
          
          const emailViewer = require('./email/emailViewer');
          emailViewer.showEmail(emailContent);
          
          global.lastEmailSearchResults = null;
          global.lastEmailSearchPrompt = null;
          
          const formattedEmail = `
Subject: ${emailContent.subject}
From: ${emailContent.from}
To: ${emailContent.to}
Date: ${emailContent.date}

Email opened in viewer window. You can reply directly from there.
${emailContent.suggestedResponse ? "\n\nSuggested response available in the viewer." : ""}
          `.trim();
          
          return { 
            type: 'email-view', 
            response: formattedEmail,
            followUpMode: true,
            followUpType: 'email-view'
          };
        }
      }
    }
    
    if (intent === 'EMAIL_VIEW') {
      const { handleEmailViewRequest } = require('./email/emailViewHandler');
      return await handleEmailViewRequest(prompt, emailFunctions, shell, win);
    }
    
    if (intent === 'EMAIL_QUERY') {
      return await emailHandlers.handleEmailQuery(prompt, emailFunctions, shell, win);
    }
    
    if (intent === 'EMAIL_DRAFT') {
      return await emailHandlers.handleEmailDraftRequest(prompt, emailFunctions, shell, win);
    }
    
    if (intent === 'EMAIL_EDIT') {
      const result = await emailHandlers.updateDraftEmail(prompt);
      return result;
    }
    
    if (intent === 'DRIVE_SEARCH') {
      const driveHandlers = require('./drive/drive-handlers');
      return await driveHandlers.handleDriveSearch(prompt, shell, win);
    }
    
    if (intent === 'DRIVE_OPEN') {
      const driveHandlers = require('./drive/drive-handlers');
      return await driveHandlers.handleDriveFileOpen(prompt, shell, win);
    }
    
    if (intent === 'DRIVE_SHARE') {
      const driveHandlers = require('./drive/drive-handlers');
      return await driveHandlers.handleDriveFileShare(prompt, shell, win);
    }
    
    if (intent === 'DOCS_CREATE') {
      const docsHandlers = require('./docs/docs-handlers');
      return await docsHandlers.handleCreateDoc(prompt, shell, win);
    }
    
    if (intent === 'DOCS_SEARCH') {
      const docsHandlers = require('./docs/docs-handlers');
      return await docsHandlers.handleSearchDocs(prompt, shell, win);
    }
    
    if (intent === 'DOCS_OPEN') {
      const docsHandlers = require('./docs/docs-handlers');
      return await docsHandlers.handleOpenDoc(prompt, shell, win);
    }
    
    if (intent === 'DOCS_SHARE') {
      const docsHandlers = require('./docs/docs-handlers');
      return await docsHandlers.handleShareDoc(prompt, shell, win);
    }
    
    if (intent === 'DOCS_UPDATE') {
      const docsHandlers = require('./docs/docs-handlers');
      return await docsHandlers.handleUpdateDoc(prompt, shell, win);
    }
    
    if (intent === 'MEET_CREATE') {
      const meetHandlers = require('./meet/meet-handlers');
      return await meetHandlers.handleCreateMeeting(prompt, shell, win);
    }
    
    if (intent === 'MEET_SHARE') {
      const meetHandlers = require('./meet/meet-handlers');
      return await meetHandlers.handleShareMeetingViaEmail(prompt, shell, win);
    }
    
    if (intent === 'SPOTIFY_PLAY') {
      console.log('[main] Handling Spotify play request');
      const spotifyHandlers = require('./spotify/spotify-handlers');
      const result = await spotifyHandlers.handlePlayMusic(prompt, shell, win);
      console.log('[main] Spotify play result:', result.type);
      return result;
    }
    
    if (intent === 'SPOTIFY_SEARCH') {
      console.log('[main] Handling Spotify search request');
      const spotifyHandlers = require('./spotify/spotify-handlers');
      return await spotifyHandlers.handleSearchMusic(prompt, shell, win);
    }
    
    if (intent === 'SPOTIFY_CONTROL') {
      console.log('[main] Handling Spotify control request');
      const spotifyHandlers = require('./spotify/spotify-handlers');
      return await spotifyHandlers.handleControlPlayback(prompt, shell, win);
    }
    
    if (intent === 'SPOTIFY_PLAYLIST') {
      console.log('[main] Handling Spotify playlist request');
      const spotifyHandlers = require('./spotify/spotify-handlers');
      
      const playlistMatch = prompt.toLowerCase().match(/(?:play|from|play from)\s+(?:the|my)?\s*["']?([\w\s\d.]+?)["']?\s*(?:playlist|on spotify|$)/i);
      if (playlistMatch) {
        return await spotifyHandlers.handlePlayFromPlaylist(playlistMatch[1].trim(), shell, win);
      }
      
      return await spotifyHandlers.handlePlaylistOperations(prompt, shell, win);
    }
    
    try {
      const isValid = await validateAndRefreshAuth();
      if (!isValid) {
        console.log('[main] Auth validation failed, requesting new authentication');
        const authUrl = await getAuthUrl();
        shell.openExternal(authUrl);
        return { type: 'error', error: 'Authentication required. Please check your browser to complete the sign-in process.' };
      }
      
      await ensureAuth(win);
    } catch (err) {
      if (err.message === 'auth required') {
        const authUrl = await getAuthUrl();
        shell.openExternal(authUrl);
        return { type: 'error', error: 'Authentication required. Please check your browser to complete the sign-in process.' };
      }
      console.error('[main] Auth error:', err);
      return { type: 'error', error: `Authentication error: ${err.message}` };
    }
    
    if (intent === 'CALENDAR_QUERY') {
      try {
        const response = await queryCalendar(prompt);
        return { type: 'query', response };
      } catch (err) {
        console.error('[main] Calendar query error:', err);
        return { type: 'error', error: `Failed to query calendar: ${err.message}` };
      }
    }
    
    return { type: 'chat', response: 'I can help you with calendar events, emails, Google Drive files, Google Docs, Google Meet meetings, and Spotify music. What would you like to do?' };
  } catch (err) {
    console.error('[main] Unhandled error in route-prompt:', err);
    return { type: 'error', error: err.message };
  }
});

ipcMain.handle('parse-and-create-event', async (_event, input) => getCalendarService().propose(input));
ipcMain.handle('calendar-confirm', async (_event, operationId, digest) => getCalendarService().confirm(operationId, digest));
ipcMain.handle('calendar-cancel', async (_event, operationId, digest) => getCalendarService().cancel(operationId, digest));
ipcMain.handle('calendar-outcomes', () => getCalendarService().outcomes());

ipcMain.handle('start-auth', async () => {
  const url = await getAuthUrl();
  shell.openExternal(url);
  return true;
});

ipcMain.handle('start-spotify-auth', async () => {
  try {
    const { getAuthUrl } = require('./spotify/spotify');
    const authUrl = await getAuthUrl();
    shell.openExternal(authUrl);
    return { success: true, message: 'Spotify authentication page opened' };
  } catch (err) {
    console.error('[main] Error starting Spotify auth:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('oauth-callback', async (event, code) => {
  try {
    await handleOAuthCallback(code);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('spotify-oauth-callback', async (event, code) => {
  try {
    const { handleOAuthCallback } = require('./spotify/spotify');
    await handleOAuthCallback(code);
    return { success: true };
  } catch (err) {
    console.error('[main] Error in Spotify OAuth callback:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-spotify-auth', async () => {
  try {
    const { validateAndRefreshAuth } = require('./spotify/spotify');
    const isValid = await validateAndRefreshAuth();
    return { success: true, isAuthenticated: isValid };
  } catch (err) {
    console.error('[main] Error checking Spotify auth:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.on('hide-window', () => {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
});

ipcMain.on('resize-window', (event, { width, height }) => {
  if (win && !win.isDestroyed()) {
    win.setSize(width, height);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('set-global-consent', async () => {
  try {
    const { setGlobalConsent } = require('./utils/authHelper');
    await setGlobalConsent();
    return { success: true };
  } catch (err) {
    console.error('[main] Error setting global consent:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('has-given-consent', async () => {
  try {
    const { hasGivenConsent } = require('./utils/authHelper');
    const result = await hasGivenConsent();
    return { hasConsent: result };
  } catch (err) {
    console.error('[main] Error checking consent status:', err);
    return { hasConsent: false, error: err.message };
  }
});