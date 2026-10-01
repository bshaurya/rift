const axios = require('axios');

class WorkflowManager {
  constructor() {
    this.workflows = {};
    this.activeWorkflow = null;
  }
  
  async detectWorkflow(prompt) {
    if (!process.env.GEMINI_API_KEY) {
      return null;
    }
    
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
      const geminiPrompt = `
      Analyze this user request and determine if it requires a multi-step workflow:
      "${prompt}"
      
      A multi-step workflow is needed when the request involves multiple tools or services in sequence.
      Examples of multi-step workflows:
      1. "Create a Google Meet for tomorrow at 3pm and email the link to john@example.com"
      2. "Find my notes about project X in Google Docs and share them with the team"
      3. "Schedule a meeting with the team and create a Google Doc for meeting notes"
      
      If this is a multi-step workflow, respond with a JSON object containing:
      {
        "isWorkflow": true,
        "workflowType": "one of: MEET_AND_EMAIL, DOCS_AND_SHARE, CALENDAR_AND_DOCS, CUSTOM",
        "steps": ["step1", "step2", ...]
      }
      
      If this is NOT a multi-step workflow, respond with:
      {
        "isWorkflow": false
      }
      
      Respond with ONLY the JSON object, nothing else.
      `;
      
      const body = {
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: {
          temperature: 0.0,
          topP: 1.0,
          topK: 1
        }
      };
      
      const resp = await axios.post(url, body, { timeout: 3000 });
      const text = resp.data.candidates[0].content.parts[0].text.trim();
      
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[0]);
          if (json.isWorkflow) {
            console.log('[workflowManager] Detected workflow:', json.workflowType);
            return json;
          }
        }
      } catch (parseErr) {
        console.error('[workflowManager] Error parsing workflow JSON:', parseErr);
      }
      
      return null;
    } catch (err) {
      console.error('[workflowManager] Error detecting workflow:', err);
      return null;
    }
  }
  
  async handleWorkflow(workflowType, prompt, handlers) {
    switch (workflowType) {
      case 'MEET_AND_EMAIL':
        return this.handleMeetAndEmailWorkflow(prompt, handlers);
      case 'DOCS_AND_SHARE':
        return this.handleDocsAndShareWorkflow(prompt, handlers);
      case 'CALENDAR_AND_DOCS':
        return this.handleCalendarAndDocsWorkflow(prompt, handlers);
      case 'CUSTOM':
        return this.handleCustomWorkflow(prompt, handlers);
      default:
        return { 
          type: 'error', 
          error: `Unknown workflow type: ${workflowType}` 
        };
    }
  }
  
  async handleMeetAndEmailWorkflow(prompt, handlers) {
    return { type: 'error', error: 'Calendar and custom workflows are blocked in the single-event reliability MVP.' };
    try {
      return await handlers.meet.handleCreateMeeting(prompt, handlers.shell, handlers.win);
    } catch (err) {
      console.error('[workflowManager] Error in Meet and Email workflow:', err);
      return { type: 'error', error: `Workflow error: ${err.message}` };
    }
  }
  
  async handleDocsAndShareWorkflow(prompt, handlers) {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return { type: 'error', error: 'Gemini API key required for workflows' };
      }
      
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
      const geminiPrompt = `
      Analyze this request for a document workflow:
      "${prompt}"
      
      Return a JSON object with these fields:
      - action: "create" if a new document should be created, "search" if an existing document should be found
      - docTitle: The title of the document to create or search for
      - docContent: The content to include in a new document (null if not applicable)
      - shareWith: An array of email addresses to share the document with
      
      Example:
      Request: "Create a document called Project Plan and share it with john@example.com"
      Response: {
        "action": "create",
        "docTitle": "Project Plan",
        "docContent": null,
        "shareWith": ["john@example.com"]
      }
      
      Only return the JSON object, nothing else.
      `;
      
      const body = {
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          topP: 1.0,
          topK: 1
        }
      };
      
      const resp = await axios.post(url, body, { timeout: 3000 });
      const text = resp.data.candidates[0].content.parts[0].text.trim();
      
      let workflowDetails;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          workflowDetails = JSON.parse(jsonMatch[0]);
        } else {
          return { type: 'error', error: 'Failed to parse workflow details' };
        }
      } catch (parseErr) {
        console.error('[workflowManager] Error parsing workflow details:', parseErr);
        return { type: 'error', error: 'Failed to parse workflow details' };
      }
      
      let docResult;
      if (workflowDetails.action === 'create') {
        const createPrompt = `create a google doc called "${workflowDetails.docTitle}" ${workflowDetails.docContent ? `with content: ${workflowDetails.docContent}` : ''}`;
        docResult = await handlers.docs.handleCreateDoc(createPrompt, handlers.shell, handlers.win);
      } else {
        const searchPrompt = `search for ${workflowDetails.docTitle} in google docs`;
        docResult = await handlers.docs.handleSearchDocs(searchPrompt, handlers.shell, handlers.win);
        
        if (docResult.type === 'docs-search' && global.lastDocsSearchResults && global.lastDocsSearchResults.length === 1) {
          const openPrompt = `open doc #1`;
          docResult = await handlers.docs.handleOpenDoc(openPrompt, handlers.shell, handlers.win);
        } else if (docResult.type === 'docs-search' && global.lastDocsSearchResults && global.lastDocsSearchResults.length > 1) {
          return {
            type: 'workflow-result',
            response: `I found multiple documents matching "${workflowDetails.docTitle}". Please specify which one you want to share.`,
            steps: ['docs-search']
          };
        }
      }
      
      if (docResult.type === 'error') {
        return docResult;
      }
      
      if (workflowDetails.shareWith && workflowDetails.shareWith.length > 0 && docResult.doc) {
        const sharePrompt = `share doc ${docResult.doc.id} with ${workflowDetails.shareWith.join(', ')}`;
        const shareResult = await handlers.docs.handleShareDoc(sharePrompt, handlers.shell, handlers.win);
        
        if (shareResult.type === 'error') {
          return {
            type: 'workflow-result',
            response: `${docResult.response}\n\nBut encountered an error sharing: ${shareResult.error}`,
            steps: ['docs-operation', 'share-error']
          };
        }
        
        return {
          type: 'workflow-result',
          response: `${docResult.response}\n\nShared with: ${workflowDetails.shareWith.join(', ')}`,
          steps: ['docs-operation', 'share-success']
        };
      }
      
      return {
        type: 'workflow-result',
        response: docResult.response,
        steps: ['docs-operation']
      };
    } catch (err) {
      console.error('[workflowManager] Error in Docs and Share workflow:', err);
      return { type: 'error', error: `Workflow error: ${err.message}` };
    }
  }
  
  async handleCalendarAndDocsWorkflow(prompt, handlers) {
    return { type: 'error', error: 'Calendar and custom workflows are blocked in the single-event reliability MVP.' };
    try {
      if (!process.env.GEMINI_API_KEY) {
        return { type: 'error', error: 'Gemini API key required for workflows' };
      }
      
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
      const geminiPrompt = `
      Analyze this request for a calendar and document workflow:
      "${prompt}"
      
      Return a JSON object with these fields:
      - eventTitle: The title for the calendar event
      - eventTime: The time for the event (e.g., "tomorrow at 3pm")
      - eventAttendees: An array of email addresses for attendees (can be empty)
      - createDoc: true if a document should be created for the event, false otherwise
      - docTitle: The title for the document (if createDoc is true)
      
      Example:
      Request: "Schedule a team meeting tomorrow at 2pm and create a doc for notes"
      Response: {
        "eventTitle": "Team Meeting",
        "eventTime": "tomorrow at 2pm",
        "eventAttendees": [],
        "createDoc": true,
        "docTitle": "Team Meeting Notes"
      }
      
      Only return the JSON object, nothing else.
      `;
      
      const body = {
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          topP: 1.0,
          topK: 1
        }
      };
      
      const resp = await axios.post(url, body, { timeout: 3000 });
      const text = resp.data.candidates[0].content.parts[0].text.trim();
      
      let workflowDetails;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          workflowDetails = JSON.parse(jsonMatch[0]);
        } else {
          return { type: 'error', error: 'Failed to parse workflow details' };
        }
      } catch (parseErr) {
        console.error('[workflowManager] Error parsing workflow details:', parseErr);
        return { type: 'error', error: 'Failed to parse workflow details' };
      }
      
      const { parseEvent } = require('../calendar/parser');
      const { createEvent, ensureAuth } = require('../calendar/google');
      
      await ensureAuth(handlers.win);
      let eventPrompt = `Create an event called "${workflowDetails.eventTitle}" ${workflowDetails.eventTime}`;
      if (workflowDetails.eventAttendees && workflowDetails.eventAttendees.length > 0) {
        eventPrompt += ` with ${workflowDetails.eventAttendees.join(', ')}`;
      }
      
      const parsed = await parseEvent(eventPrompt);
      
      if (typeof parsed === 'string') {
        return { type: 'chat', response: parsed };
      }
      
      if (!parsed.start || !parsed.end) {
        return { 
          type: 'chat', 
          response: `I understood you want to create an event titled "${parsed.title}", but I need more information about the date and time.` 
        };
      }
      
      const eventResult = await createEvent(parsed);
      if (workflowDetails.createDoc) {
        const docTitle = workflowDetails.docTitle || `Notes: ${parsed.title} - ${new Date(parsed.start).toLocaleDateString()}`;
        const docContent = `Meeting Notes: ${parsed.title}\nDate: ${new Date(parsed.start).toLocaleString()} - ${new Date(parsed.end).toLocaleString()}\n\nAttendees: ${parsed.attendees ? parsed.attendees.join(', ') : ''}\n\n# Agenda\n\n# Discussion\n\n# Action Items\n`;
        
        const docPrompt = `create a google doc called "${docTitle}" with content: ${docContent}`;
        const docResult = await handlers.docs.handleCreateDoc(docPrompt, handlers.shell, handlers.win);
        
        if (docResult.type === 'error') {
          return {
            type: 'workflow-result',
            response: `Created calendar event: "${eventResult.summary}"\n\nBut encountered an error creating notes document: ${docResult.error}`,
            steps: ['calendar-create', 'docs-error']
          };
        }
        
        return {
          type: 'workflow-result',
          response: `Created calendar event: "${eventResult.summary}"\n\nCreated meeting notes document: "${docTitle}"\n\nYou can access the notes at: ${docResult.doc.webViewLink}`,
          steps: ['calendar-create', 'docs-create']
        };
      }
      
      return {
        type: 'workflow-result',
        response: `Created calendar event: "${eventResult.summary}"`,
        steps: ['calendar-create']
      };
    } catch (err) {
      console.error('[workflowManager] Error in Calendar and Docs workflow:', err);
      return { type: 'error', error: `Workflow error: ${err.message}` };
    }
  }
  
  async handleCustomWorkflow(prompt, handlers) {
    return { type: 'error', error: 'Calendar and custom workflows are blocked in the single-event reliability MVP.' };
    try {
      console.log('[workflowManager] Starting custom workflow for prompt:', prompt);
      if (/\b(create|make|set up|schedule)\s+(a\s+)?(google\s+)?meet(ing)?\b/i.test(prompt)) {
        console.log('[workflowManager] Detected Google Meet creation request, handling directly');
        return await handlers.meet.handleCreateMeeting(prompt, handlers.shell, handlers.win);
      }
      
      if (!process.env.GEMINI_API_KEY) {
        return { type: 'error', error: 'Gemini API key required for custom workflows' };
      }
      
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
      const geminiPrompt = `
      Analyze this user request and break it down into a sequence of steps:
      "${prompt}"
      
      Available tools:
      - EMAIL: Create, send, search emails
      - CALENDAR: Create, modify, query calendar events
      - DRIVE: Search, open, share files in Google Drive
      - DOCS: Create, search, open, update, share Google Docs
      - MEET: Create, share Google Meet links
      
      Respond with a JSON object containing:
      {
        "steps": [
          {
            "tool": "one of: EMAIL, CALENDAR, DRIVE, DOCS, MEET",
            "action": "specific action to take",
            "prompt": "prompt to use for this step"
          },
          ...
        ]
      }
      
      Respond with ONLY the JSON object, nothing else.
      `;
      
      const body = {
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          topP: 1.0,
          topK: 1
        }
      };
      
      console.log('[workflowManager] Sending request to Gemini API');
      const resp = await axios.post(url, body, { timeout: 5000 });
      const text = resp.data.candidates[0].content.parts[0].text.trim();
      console.log('[workflowManager] Received response from Gemini API');
      
      let workflowSteps;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[0]);
          workflowSteps = json.steps;
          console.log('[workflowManager] Parsed workflow steps:', workflowSteps.length);
        } else {
          console.error('[workflowManager] No JSON found in Gemini response');
          return { type: 'error', error: 'Failed to parse workflow steps' };
        }
      } catch (parseErr) {
        console.error('[workflowManager] Error parsing custom workflow JSON:', parseErr);
        return { type: 'error', error: 'Failed to parse workflow steps' };
      }
      
      if (!workflowSteps || !Array.isArray(workflowSteps) || workflowSteps.length === 0) {
        console.error('[workflowManager] No valid workflow steps identified');
        return { type: 'error', error: 'No valid workflow steps identified' };
      }
      
      const results = [];
      let combinedResponse = '';
      let contextData = {};
      for (let i = 0; i < workflowSteps.length; i++) {
        const step = workflowSteps[i];
        console.log(`[workflowManager] Executing step ${i+1}/${workflowSteps.length}: ${step.tool}/${step.action}`);
        
        let stepResult = null;
        
        try {
          let enhancedPrompt = step.prompt;
          if (Object.keys(contextData).length > 0) {
            enhancedPrompt = await this.enhancePromptWithContext(step.prompt, contextData);
          }
          
          console.log(`[workflowManager] Using prompt: ${enhancedPrompt}`);
          if (step.tool === 'MEET' && step.action.includes('create')) {
            console.log('[workflowManager] Handling Google Meet creation directly');
            stepResult = await handlers.meet.handleCreateMeeting(enhancedPrompt, handlers.shell, handlers.win);
            
            if (stepResult && stepResult.meeting) {
              contextData.meeting = stepResult.meeting;
            }
          }
          else if (step.tool === 'MEET' && (step.action.includes('share') || step.action.includes('email'))) {
            console.log('[workflowManager] Handling Google Meet sharing');
            
            if (contextData.meeting && contextData.meeting.meetLink) {
              const { ensureEmailAuth, getUserEmail, sendEmail } = require('../email/email');
              const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
              const emails = enhancedPrompt.match(emailRegex) || [];
              
              if (emails.length > 0) {
                await ensureEmailAuth(handlers.win);
                const userEmail = await getUserEmail();
                
                const emailDraft = {
                  from: userEmail,
                  to: emails.join(', '),
                  subject: `Invitation: ${contextData.meeting.summary}`,
                  body: `I'd like to invite you to a meeting: ${contextData.meeting.summary}\n\nGoogle Meet link: ${contextData.meeting.meetLink}`
                };
                
                await sendEmail(emailDraft);
                stepResult = { 
                  type: 'meet-share', 
                  response: `Shared meeting link via email with: ${emails.join(', ')}`,
                  success: true
                };
              } else {
                stepResult = { 
                  type: 'error', 
                  error: 'No email addresses found in the prompt to share the meeting with.',
                  response: 'No email addresses found to share the meeting with.'
                };
              }
            } else {
              stepResult = await handlers.meet.handleShareMeetingViaEmail(enhancedPrompt, handlers.shell, handlers.win);
            }
          }
          else {
            switch (step.tool) {
              case 'EMAIL':
                if (step.action.includes('draft') || step.action.includes('send')) {
                  stepResult = await handlers.email.handleEmailDraftRequest(enhancedPrompt, handlers.shell, handlers.win);
                } else if (step.action.includes('search') || step.action.includes('query')) {
                  stepResult = await handlers.email.handleEmailQuery(enhancedPrompt, handlers.shell, handlers.win);
                } else if (step.action.includes('view') || step.action.includes('open')) {
                  stepResult = await handlers.email.handleEmailViewRequest(enhancedPrompt, handlers.shell, handlers.win);
                }
                break;
                
              case 'CALENDAR':
                if (step.action.includes('create')) {
                  const { parseEvent } = require('../calendar/parser');
                  const { createEvent, ensureAuth } = require('../calendar/google');
                  await ensureAuth(handlers.win);
                  const parsed = await parseEvent(enhancedPrompt);
                  
                  if (typeof parsed === 'string') {
                    stepResult = { type: 'chat', response: parsed };
                  } else if (!parsed.start || !parsed.end) {
                    stepResult = { 
                      type: 'chat', 
                      response: `I understood you want to create an event titled "${parsed.title}", but I need more information about the date and time.` 
                    };
                  } else {
                    const result = await createEvent(parsed);
                    stepResult = { type: 'event', success: true, result, response: `Created event: ${result.summary}` };
                    contextData.event = result;
                  }
                } else if (step.action.includes('query')) {
                  const { queryCalendar } = require('../calendar/calendarQuery');
                  const response = await queryCalendar(enhancedPrompt);
                  stepResult = { type: 'query', response };
                }
                break;
                
              case 'DRIVE':
                if (step.action.includes('search')) {
                  stepResult = await handlers.drive.handleDriveSearch(enhancedPrompt, handlers.shell, handlers.win);
                  if (stepResult && stepResult.type === 'drive-search' && global.lastDriveSearchResults) {
                    contextData.driveFiles = global.lastDriveSearchResults;
                  }
                } else if (step.action.includes('open')) {
                  stepResult = await handlers.drive.handleDriveFileOpen(enhancedPrompt, handlers.shell, handlers.win);
                  if (stepResult && stepResult.file) {
                    contextData.driveFile = stepResult.file;
                  }
                } else if (step.action.includes('share')) {
                  stepResult = await handlers.drive.handleDriveFileShare(enhancedPrompt, handlers.shell, handlers.win);
                }
                break;
                
              case 'DOCS':
                if (step.action.includes('create')) {
                  stepResult = await handlers.docs.handleCreateDoc(enhancedPrompt, handlers.shell, handlers.win);
                  if (stepResult && stepResult.doc) {
                    contextData.doc = stepResult.doc;
                  }
                } else if (step.action.includes('search')) {
                  stepResult = await handlers.docs.handleSearchDocs(enhancedPrompt, handlers.shell, handlers.win);
                  if (stepResult && stepResult.type === 'docs-search' && global.lastDocsSearchResults) {
                    contextData.docs = global.lastDocsSearchResults;
                  }
                } else if (step.action.includes('open')) {
                  stepResult = await handlers.docs.handleOpenDoc(enhancedPrompt, handlers.shell, handlers.win);
                  if (stepResult && stepResult.doc) {
                    contextData.doc = stepResult.doc;
                  }
                } else if (step.action.includes('share')) {
                  stepResult = await handlers.docs.handleShareDoc(enhancedPrompt, handlers.shell, handlers.win);
                } else if (step.action.includes('update')) {
                  stepResult = await handlers.docs.handleUpdateDoc(enhancedPrompt, handlers.shell, handlers.win);
                }
                break;
                
              default:
                stepResult = { type: 'error', error: `Unknown tool: ${step.tool}`, response: `Unknown tool: ${step.tool}` };
            }
          }
        } catch (stepErr) {
          console.error(`[workflowManager] Error executing step ${step.tool}/${step.action}:`, stepErr);
          stepResult = { 
            type: 'error', 
            error: `Failed to execute ${step.action}: ${stepErr.message}`,
            response: `Failed to execute ${step.action}: ${stepErr.message}`
          };
        }
        
        if (!stepResult) {
          console.error(`[workflowManager] Step ${i+1} (${step.tool}/${step.action}) returned undefined result`);
          stepResult = { 
            type: 'error', 
            response: `Step ${step.tool}/${step.action} did not produce a result`,
            error: 'No result produced'
          };
        }
        
        results.push(stepResult);
        
        if (stepResult.type === 'error') {
          combinedResponse += `\n\nStep ${results.length} (${step.action}) error: ${stepResult.error}`;
        } else {
          combinedResponse += `\n\nStep ${results.length} (${step.action}): ${stepResult.response || 'Completed successfully'}`;
        }
        
        if (stepResult.type === 'error' && step.critical) {
          console.log('[workflowManager] Critical step failed, aborting workflow');
          break;
        }
      }
      
      return {
        type: 'workflow-result',
        response: `Completed workflow with ${results.length} steps:${combinedResponse}`,
        steps: results.map(r => r.type)
      };
    } catch (err) {
      console.error('[workflowManager] Error in custom workflow:', err);
      return { type: 'error', error: `Workflow error: ${err.message}` };
    }
  }
  
  async enhancePromptWithContext(prompt, contextData) {
    if (!process.env.GEMINI_API_KEY) {
      return prompt;
    }
    
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
      let contextString = '';
      if (contextData.event) {
        contextString += `Event: ${JSON.stringify(contextData.event)}\n`;
      }
      if (contextData.doc) {
        contextString += `Document: ${JSON.stringify(contextData.doc)}\n`;
      }
      if (contextData.meeting) {
        contextString += `Meeting: ${JSON.stringify(contextData.meeting)}\n`;
      }
      if (contextData.driveFile) {
        contextString += `Drive File: ${JSON.stringify(contextData.driveFile)}\n`;
      }
      
      const geminiPrompt = `
      Enhance this prompt with context from previous workflow steps:
      
      Original prompt: "${prompt}"
      
      Context from previous steps:
      ${contextString}
      
      Return an enhanced prompt that includes relevant information from the context.
      Only return the enhanced prompt, nothing else.
      `;
      
      const body = {
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          topP: 1.0,
          topK: 1
        }
      };
      
      const resp = await axios.post(url, body, { timeout: 3000 });
      const enhancedPrompt = resp.data.candidates[0].content.parts[0].text.trim();
      
      return enhancedPrompt || prompt;
    } catch (err) {
      console.error('[workflowManager] Error enhancing prompt with context:', err);
      return prompt;
    }
  }
}

module.exports = new WorkflowManager();