const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rift', {
  parseAndCreateEvent: (input) => ipcRenderer.invoke('parse-and-create-event', input),
  confirmCalendar: (id, digest) => ipcRenderer.invoke('calendar-confirm', id, digest),
  cancelCalendar: (id, digest) => ipcRenderer.invoke('calendar-cancel', id, digest),
  calendarOutcomes: () => ipcRenderer.invoke('calendar-outcomes'),
  startAuth: () => ipcRenderer.invoke('start-auth'),
  oauthCallback: (code) => ipcRenderer.invoke('oauth-callback', code),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', cb),
  hideWindow: () => ipcRenderer.send('hide-window'),
  routePrompt: (input) => ipcRenderer.invoke('route-prompt', input),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
  getUnreadEmails: () => ipcRenderer.invoke('get-unread-emails'),
  getEmailContent: (messageId) => ipcRenderer.invoke('get-email-content', messageId),
  saveDraft: (draft) => ipcRenderer.invoke('save-draft', draft),
  sendDraft: () => ipcRenderer.invoke('send-draft'),
  storeHistory: (prompt, response) => ipcRenderer.invoke('store-history', prompt, response),
  getHistory: () => ipcRenderer.invoke('get-history'),
  startEmailAuth: () => ipcRenderer.invoke('start-email-auth'),
  emailOAuthCallback: (code) => ipcRenderer.invoke('email-oauth-callback', code),
  startSpotifyAuth: () => ipcRenderer.invoke('start-spotify-auth'),
  spotifyOAuthCallback: (code) => ipcRenderer.invoke('spotify-oauth-callback', code),
  checkSpotifyAuth: () => ipcRenderer.invoke('check-spotify-auth')
});