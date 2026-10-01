const { CalendarGate } = require('./gate');
const { FileJournal } = require('./journal');

function createCalendarService(filename) {
  const { parseEvent } = require('./parser');
  const { google } = require('googleapis');
  const { ensureAuth } = require('./google');
  const gate = new CalendarGate({
    store: new FileJournal(filename),
    model: async input => JSON.stringify(await parseEvent(input)),
    calendar: { create: async (action, operationId) => {
      let auth;
      try { auth = await ensureAuth(); }
      catch { const error = new Error('Authentication required.'); error.beforeWrite = true; error.code = 401; throw error; }
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.events.insert({ calendarId: 'primary', resource: {
        id: operationId.replaceAll('-', ''), summary: action.title,
        start: { dateTime: action.start, timeZone: action.timeZone },
        end: { dateTime: action.end, timeZone: action.timeZone },
        location: action.location, description: action.description
      } }, { retry: false, timeout: 10000 });
      return { id: response.data.id };
    } }
  });
  const wrap = action => async (...args) => {
    try { return { type: 'calendar-proposal', proposal: await action(...args) }; }
    catch (error) { return { type: 'error', error: error.message }; }
  };
  return {
    propose: wrap(input => gate.propose(input)),
    confirm: wrap((id, digest) => gate.confirm(id, digest)),
    cancel: wrap((id, digest) => gate.cancel(id, digest)),
    outcomes: () => Object.values(gate.records).map(r => gate.get(r.operationId))
  };
}
module.exports = { createCalendarService };
