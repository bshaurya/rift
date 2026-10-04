require('dotenv').config();
const { google } = require('googleapis');
const { ensureAuth } = require('../calendar/google');

async function createMeeting(title, startTime, endTime, attendees = [], description = '') {
  throw new Error('This calendar write is blocked in the single-event reliability MVP.');
  try {
    const auth = await ensureAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const formattedAttendees = attendees.map(email => ({ email }));
    const event = {
      summary: title,
      description,
      start: {
        dateTime: startTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      end: {
        dateTime: endTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      attendees: formattedAttendees,
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`
        }
      }
    };
    
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });
    
    return {
      id: response.data.id,
      meetLink: response.data.hangoutLink,
      eventLink: response.data.htmlLink,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      attendees: response.data.attendees
    };
  } catch (err) {
    console.error('[meet] Error creating meeting:', err);
    throw err;
  }
}

async function getMeeting(eventId) {
  try {
    const auth = await ensureAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    
    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId
    });
    
    return {
      id: response.data.id,
      meetLink: response.data.hangoutLink,
      eventLink: response.data.htmlLink,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      attendees: response.data.attendees,
      description: response.data.description
    };
  } catch (err) {
    console.error('[meet] Error getting meeting:', err);
    throw err;
  }
}

async function updateMeeting(eventId, updates) {
  throw new Error('This calendar write is blocked in the single-event reliability MVP.');
  try {
    const auth = await ensureAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const currentEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId
    });
    
    const updatedEvent = {
      ...currentEvent.data,
      ...updates
    };
    
    if (updates.attendees) {
      updatedEvent.attendees = updates.attendees.map(email => {
        if (typeof email === 'string') {
          return { email };
        }
        return email;
      });
    }
    
    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId,
      resource: updatedEvent,
      sendUpdates: 'all'
    });
    
    return {
      id: response.data.id,
      meetLink: response.data.hangoutLink,
      eventLink: response.data.htmlLink,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      attendees: response.data.attendees
    };
  } catch (err) {
    console.error('[meet] Error updating meeting:', err);
    throw err;
  }
}

async function addAttendeesToMeeting(eventId, newAttendees) {
  throw new Error('This calendar write is blocked in the single-event reliability MVP.');
  try {
    const auth = await ensureAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.get({
      calendarId: 'primary',
      eventId
    });
    const formattedNewAttendees = newAttendees.map(email => ({ email }));
    const existingEmails = new Set((event.data.attendees || []).map(a => a.email));
    const combinedAttendees = [
      ...(event.data.attendees || []),
      ...formattedNewAttendees.filter(a => !existingEmails.has(a.email))
    ];
    
    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      resource: {
        attendees: combinedAttendees
      },
      sendUpdates: 'all'
    });
    
    return {
      id: response.data.id,
      meetLink: response.data.hangoutLink,
      eventLink: response.data.htmlLink,
      summary: response.data.summary,
      attendees: response.data.attendees
    };
  } catch (err) {
    console.error('[meet] Error adding attendees to meeting:', err);
    throw err;
  }
}

module.exports = {
  createMeeting,
  getMeeting,
  updateMeeting,
  addAttendeesToMeeting
};