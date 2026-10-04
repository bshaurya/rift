const { CalendarGate } = require('./gate');
const { FileJournal } = require('./journal');

function createCalendarService(filename) {
  const { parseEvent } = require('./parser');
  const { google } = require('googleapis');
  const { ensureAuth } = require('./google');
  const resolveCalendar = async () => {
    let auth;
    try { auth = await ensureAuth(); }
    catch { throw Object.assign(new Error('Authentication required.'), { beforeWrite: true, code: 401 }); }
    const calendar = google.calendar({ version: 'v3', auth });
    try {
      const response = await calendar.calendars.get({ calendarId: 'primary' }, { retry: false, timeout: 10000 });
      const id = response.data?.id;
      if (typeof id !== 'string' || !id.trim() || id.length > 1024) throw new Error('Calendar destination is unavailable.');
      return { calendar, id };
    } catch (error) { error.beforeWrite = true; throw error; }
  };
  const gate = new CalendarGate({
    store: new FileJournal(filename),
    model: async input => JSON.stringify(await parseEvent(input)),
    calendar: {
      destination: async () => (await resolveCalendar()).id,
      create: async (action, operationId, destination) => {
        const { calendar, id } = await resolveCalendar();
        if (id !== destination) throw Object.assign(new Error('Calendar account changed. Review a new proposal.'), { beforeWrite: true, destinationChanged: true });
        const response = await calendar.events.insert({ calendarId: destination, resource: {
          id: operationId.replaceAll('-', ''), summary: action.title,
          start: { dateTime: action.start, timeZone: action.timeZone },
          end: { dateTime: action.end, timeZone: action.timeZone },
          location: action.location, description: action.description
        } }, { retry: false, timeout: 10000 });
        return { id: response.data?.id };
      }
    }
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
