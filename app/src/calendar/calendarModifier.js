require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

async function identifyEventToModify(prompt, events) {
  if (!process.env.GEMINI_API_KEY || !events || events.length === 0) {
    return null;
  }

  try {
    const eventsText = events.map((event, i) => {
      const start = event.start.dateTime || event.start.date;
      const startDate = new Date(start);
      const timeStr = startDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const dateStr = startDate.toLocaleDateString();
      return `Event ${i+1}: "${event.summary}" on ${dateStr} at ${timeStr}, Location: ${event.location || 'Not specified'}`;
    }).join('\n');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const geminiPrompt = `
    Based on the user's request: "${prompt}"
    
    Which of these events should be modified?
    ${eventsText}
    
    Respond with ONLY the number of the event to modify (e.g., "1" or "2"). If none match, respond with "none".
    `;

    const body = {
      contents: [{ parts: [{ text: geminiPrompt }] }]
    };
    
    const resp = await axios.post(url, body, { timeout: 5000 });
    const text = resp.data.candidates[0].content.parts[0].text.trim();
    const match = text.match(/\b(\d+)\b/);

    if (match) {
      const eventIndex = parseInt(match[1]) - 1;
      if (eventIndex >= 0 && eventIndex < events.length) {
        return events[eventIndex];
      }
    }
    
    return null;
  }
  catch (err) {
    console.error('[calendarModifier] Error identifying event to modify:', err);
    return null;
  }
}

async function determineEventChanges(prompt, event) {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const geminiPrompt = `
    Based on the user's request: "${prompt}"
    
    Analyze what changes should be made to this event:
    Title: ${event.summary}
    Start: ${event.start.dateTime || event.start.date}
    End: ${event.end.dateTime || event.end.date}
    Location: ${event.location || 'Not specified'}
    Description: ${event.description || 'Not specified'}
    
    Respond with a JSON object containing ONLY the fields that should be changed:
    {
      "summary": "New title if it should be changed",
      "location": "New location if it should be changed",
      "description": "New description if it should be changed",
      "addMeet": true/false (if a Google Meet link should be added),
      "addAttendees": ["email1@example.com", "email2@example.com"] (if attendees should be added)
    }
    
    Only include fields that need to be changed based on the user's request.
    `;

    const body = {
      contents: [{ parts: [{ text: geminiPrompt }] }]
    };
    
    const resp = await axios.post(url, body, { timeout: 5000 });
    const text = resp.data.candidates[0].content.parts[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return null;
  } catch (err) {
    console.error('[calendarModifier] Error determining event changes:', err);
    return null;
  }
}

async function modifyEvent(auth, eventId, changes) {
  throw new Error('This calendar write is blocked in the single-event reliability MVP.');
  try {
    const calendar = google.calendar({ 
      version: 'v3', 
      auth: auth,
      key: process.env.GOOGLE_API_KEY
    });
    
    const eventRes = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    const event = eventRes.data;
    
    if (changes.summary) event.summary = changes.summary;
    if (changes.location) event.location = changes.location;
    if (changes.description) event.description = changes.description;
    if (changes.addMeet) {
      event.conferenceData = {
        createRequest: {
          requestId: `meet-${Date.now()}`
        }
      };
    }
    
    if (changes.addAttendees && Array.isArray(changes.addAttendees)) {
      if (!event.attendees) event.attendees = [];
        changes.addAttendees.forEach(email => {
        const exists = event.attendees.some(a => a.email === email);
        if (!exists) {
          event.attendees.push({ email });
        }
      });
    }
    
    const res = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      resource: event,
      conferenceDataVersion: changes.addMeet ? 1 : 0,
      sendUpdates: 'all'
    });
    
    return res.data;
  } catch (err) {
    console.error('[calendarModifier] Error modifying event:', err);
    throw err;
  }
}

async function handleEventModification(prompt, auth) {
  throw new Error('This calendar write is blocked in the single-event reliability MVP.');
  try {
    const calendar = google.calendar({ 
      version: 'v3', 
      auth: auth,
      key: process.env.GOOGLE_API_KEY
    });
    
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10
    });
    
    const events = eventsRes.data.items || [];
    if (events.length === 0) {
      return { success: false, error: 'No upcoming events found to modify.' };
    }
    
    const eventToModify = await identifyEventToModify(prompt, events);
    if (!eventToModify) {
      return { success: false, error: 'Could not identify which event to modify.' };
    }
    
    const changes = await determineEventChanges(prompt, eventToModify);
    if (!changes) {
      return { success: false, error: 'Could not determine what changes to make to the event.' };
    }
    
    const updatedEvent = await modifyEvent(auth, eventToModify.id, changes);
    let changesSummary = [];
    if (changes.summary) changesSummary.push(`Title changed to "${changes.summary}"`);
    if (changes.location) changesSummary.push(`Location changed to "${changes.location}"`);
    if (changes.description) changesSummary.push(`Description updated`);
    if (changes.addMeet) changesSummary.push(`Google Meet link added`);
    if (changes.addAttendees) changesSummary.push(`${changes.addAttendees.length} attendee(s) added`);
    
    return { 
      success: true, 
      event: updatedEvent,
      changes: changesSummary.join(', ')
    };
  }
  catch (err) {
    console.error('[calendarModifier] Error handling event modification:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  handleEventModification
};