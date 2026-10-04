const input = document.getElementById('input');
const status = document.getElementById('status');
const responseDiv = document.getElementById('response');

function showStatus(msg, color = '#a0ffa0') {
  status.textContent = msg;
  status.style.color = color;
}

function clearFollowUpMode() {
  responseDiv.classList.remove('follow-up-mode');
  delete responseDiv.dataset.contextPrompt;
  delete responseDiv.dataset.contextResponse;
  delete responseDiv.dataset.followUpLabel;
  delete responseDiv.dataset.followUpMode;
}

function setFollowUpMode(prompt, response, mode = 'draft', label = null) {
  responseDiv.dataset.contextPrompt = prompt;
  responseDiv.dataset.contextResponse = response;
  responseDiv.dataset.followUpMode = mode;
  
  if (label) {
    responseDiv.dataset.followUpLabel = label;
  } else {
    switch (mode) {
      case 'draft':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Type to improve this draft';
        break;
      case 'email-search':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Select an email to view';
        break;
      case 'email-view':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Ask about this email';
        break;
      case 'drive-search':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Select a file to open';
        break;
      case 'docs-search':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Select a document to open';
        break;
      case 'spotify-playlist-selection':
        responseDiv.dataset.followUpLabel = 'Follow-up mode - Select a playlist to play';
        break;
      default:
        responseDiv.dataset.followUpLabel = 'Follow-up mode';
    }
  }
  
  responseDiv.classList.add('follow-up-mode');
}

function showResponse(msg) {
  if (!msg) {
    responseDiv.innerHTML = '';
    responseDiv.style.display = 'none';
    return;
  }
  
  const formattedMsg = formatMarkdown(msg);
  responseDiv.innerHTML = formattedMsg;
  responseDiv.style.display = 'block';
  resizeWindowToFitContent();
}

function formatMarkdown(text) {
  if (!text) return '';
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/\n/g, '<br>');
  
  return text;
}

function resizeWindowToFitContent() {
  const container = document.getElementById('bar-container');
  if (container) {
    const height = container.scrollHeight + 40;
    window.rift.resizeWindow(480, Math.max(300, height));
  }
}

async function routePrompt() {
  const val = input.value.trim();
  if (!val) return;
  
  console.log('Processing prompt:', val);
  showStatus('Processing...');
  
  const isFollowUp = responseDiv.classList.contains('follow-up-mode');
  const contextPrompt = responseDiv.dataset.contextPrompt;
  const contextResponse = responseDiv.dataset.contextResponse;
  const followUpMode = responseDiv.dataset.followUpMode;
  
  if (!isFollowUp) {
    showResponse('');
  }
  
  let effectivePrompt = val;
  if (isFollowUp && contextPrompt) {
    console.log('Using follow-up context, mode:', followUpMode);
    effectivePrompt = `FOLLOW_UP_CONTEXT: ${contextPrompt}\nPREVIOUS_RESPONSE: ${contextResponse}\nFOLLOW_UP_MODE: ${followUpMode || 'general'}\nNEW_PROMPT: ${val}`;
  }
  
  try {
    const res = await window.rift.routePrompt(effectivePrompt);
    console.log('Response received:', res);
    
    if (res.type === 'calendar-proposal') {
      clearFollowUpMode();
      showCalendarProposal(res.proposal);
    } else if (res.type === 'event') {
      if (res.success) {
        showStatus('Event added to Google Calendar!');
        input.value = '';
        
        if (res.result && res.result.summary) {
          const startTime = res.result.start && res.result.start.dateTime ? 
            new Date(res.result.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
          const startDate = res.result.start && res.result.start.dateTime ? 
            new Date(res.result.start.dateTime).toLocaleDateString() : '';
          
          showResponse(`✅ Created: **${res.result.summary}**${startTime ? ' at ' + startTime : ''}${startDate ? ' on ' + startDate : ''}`);
        }
        clearFollowUpMode();
      } else {
        showStatus('Error: ' + (res.error || 'Unknown error'), '#ffa0a0');
      }
    } else if (res.type === 'event-modified') {
      if (res.success) {
        showStatus('Event modified successfully!');
        input.value = '';
        
        if (res.result && res.result.summary) {
          const startTime = res.result.start && res.result.start.dateTime ? 
            new Date(res.result.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
          const startDate = res.result.start && res.result.start.dateTime ? 
            new Date(res.result.start.dateTime).toLocaleDateString() : '';
          
          showResponse(`✅ Modified: **${res.result.summary}**${startTime ? ' at ' + startTime : ''}${startDate ? ' on ' + startDate : ''}\n\nChanges: ${res.changes}`);
        }
        clearFollowUpMode();
      } else {
        showStatus('Error: ' + (res.error || 'Unknown error'), '#ffa0a0');
      }
    } else if (res.type === 'query') {
      showStatus('Calendar query results:');
      showResponse(`📅 Here's what I found on your calendar:\n\n${res.response || 'No events found.'}`);
      clearFollowUpMode();
    } else if (res.type === 'delete') {
      showStatus('Event deleted successfully!');
      showResponse(`🗑️ ${res.response || 'Event deleted.'}`);
      clearFollowUpMode();
    } else if (res.type === 'email-unread') {
      showStatus('Unread emails:');
      showResponse(`📬 ${res.response || 'No unread emails.'}`);
      clearFollowUpMode();
    } else if (res.type === 'email-search-results') {
      showStatus('Email search results:');
      showResponse(`🔍 ${res.response || 'No matching emails found.'}`);
      
      if (res.followUpMode) {
        setFollowUpMode(val, res.response, 'email-search', 'Follow-up mode - Select an email to view');
      } else {
        clearFollowUpMode();
      }
    } else if (res.type === 'email-view') {
      showStatus('Email content:');
      showResponse(`📨 ${res.response || 'Email not found.'}`);
      
      if (res.followUpMode) {
        setFollowUpMode(val, res.response, 'email-view', 'Follow-up mode - Ask about this email');
      } else {
        clearFollowUpMode();
      }
    } else if (res.type === 'email-draft') {
      showStatus('Email draft created');
      showResponse(`📝 ${res.response || 'Draft created.'}`);
      
      setFollowUpMode(val, res.response, 'draft', 'Follow-up mode - Type to improve this draft');
    } else if (res.type === 'email-sent') {
      showStatus('Email sent successfully!');
      input.value = '';
      showResponse(`📤 ${res.response || 'Email sent.'}`);
      clearFollowUpMode();
    } else if (res.type === 'drive-search') {
      showStatus('Google Drive search results:');
      showResponse(`📁 ${res.response || 'No files found.'}`);
      
      if (res.followUpMode) {
        setFollowUpMode(val, res.response, 'drive-search', 'Follow-up mode - Select a file to open');
      } else {
        clearFollowUpMode();
      }
    } else if (res.type === 'drive-open') {
      showStatus('Google Drive file opened:');
      showResponse(`📄 ${res.response || 'File opened.'}`);
      clearFollowUpMode();
    } else if (res.type === 'drive-share') {
      showStatus('Google Drive file shared:');
      showResponse(`🔗 ${res.response || 'File shared.'}`);
      clearFollowUpMode();
    } else if (res.type === 'docs-create') {
      showStatus('Google Doc created:');
      showResponse(`📝 ${res.response || 'Document created.'}`);
      clearFollowUpMode();
    } else if (res.type === 'docs-search') {
      showStatus('Google Docs search results:');
      showResponse(`🔍 ${res.response || 'No documents found.'}`);
      
      if (res.followUpMode) {
        setFollowUpMode(val, res.response, 'docs-search', 'Follow-up mode - Select a document to open');
      } else {
        clearFollowUpMode();
      }
    } else if (res.type === 'docs-open') {
      showStatus('Google Doc opened:');
      showResponse(`📄 ${res.response || 'Document opened.'}`);
      clearFollowUpMode();
    } else if (res.type === 'docs-share') {
      showStatus('Google Doc shared:');
      showResponse(`🔗 ${res.response || 'Document shared.'}`);
      clearFollowUpMode();
    } else if (res.type === 'docs-update') {
      showStatus('Google Doc updated:');
      showResponse(`✏️ ${res.response || 'Document updated.'}`);
      clearFollowUpMode();
    } else if (res.type === 'meet-create') {
      showStatus('Google Meet created:');
      showResponse(`🎥 ${res.response || 'Meeting created.'}`);
      clearFollowUpMode();
    } else if (res.type === 'meet-share') {
      showStatus('Google Meet shared:');
      showResponse(`🔗 ${res.response || 'Meeting shared.'}`);
      clearFollowUpMode();
    } else if (res.type === 'spotify-play') {
      if (res.success) {
        showStatus('Spotify playback:');
        showResponse(`🎵 ${res.result || 'Music playing.'}`);
        clearFollowUpMode();
      } else if (res.followUpMode) {
        showStatus('Spotify playlists:');
        showResponse(`🎵 ${res.error || 'Please select a playlist.'}`);
        setFollowUpMode(val, res.error, 'spotify-playlist-selection', 'Follow-up mode - Select a playlist to play');
      } else {
        showStatus('Spotify error:', '#ffa0a0');
        showResponse(`🎵 ${res.error || 'Error playing music.'}`);
        clearFollowUpMode();
      }
    } else if (res.type === 'spotify-search') {
      showStatus('Spotify search results:');
      showResponse(`🔍 ${res.result || 'Search results.'}`);
      clearFollowUpMode();
    } else if (res.type === 'spotify-control') {
      showStatus('Spotify control:');
      showResponse(`⏯️ ${res.result || 'Playback controlled.'}`);
      clearFollowUpMode();
    } else if (res.type === 'spotify-playlist') {
      showStatus('Spotify playlist:');
      showResponse(`📋 ${res.result || 'Playlist operation completed.'}`);
      
      if (res.followUpMode) {
        setFollowUpMode(val, res.result, 'spotify-playlist-selection', 'Follow-up mode - Select a playlist to play');
      } else {
        clearFollowUpMode();
      }
    } else if (res.type === 'workflow-result') {
      showStatus('Workflow completed:');
      showResponse(`🔄 ${res.response || 'Workflow completed.'}`);
      clearFollowUpMode();
    } else if (res.type === 'chat') {
      showStatus('');
      showResponse(`💬 ${res.response || 'I understand your request.'}`);
      clearFollowUpMode();
    } else if (res.type === 'error') {
      showStatus(res.error || 'Unknown error', '#ffa0a0');
      showResponse(`❌ ${res.error || 'An error occurred.'}`);
    } else {
      showStatus('Unknown response type.', '#ffa0a0');
      showResponse('');
      clearFollowUpMode();
    }
  } catch (err) {
    console.error('Error in routePrompt:', err);
    showStatus('Error processing request', '#ffa0a0');
    showResponse(`❌ Error: ${err.message}`);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    console.log('Enter key pressed');
    e.preventDefault();
    routePrompt();
  }
  if (e.key === 'Escape') window.rift.hideWindow();
  
  // cmd shift r - Reset prompt and clear follow-up mode
  if (e.metaKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    input.value = '';
    showStatus('Prompt reset');
    showResponse('');
    
    clearFollowUpMode();
    
    setTimeout(() => showStatus(''), 1500);
  }
  
  // cmd shift f - Store prompt and response for follow-up
  if (e.metaKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    const currentPrompt = input.value.trim();
    const currentResponse = responseDiv.innerHTML.trim();
    
    if (responseDiv.classList.contains('follow-up-mode')) {
      showStatus('Already in follow-up mode', '#ffa0a0');
      setTimeout(() => showStatus(''), 1500);
      return;
    }
    
    if (responseDiv.innerHTML.trim()) {
      console.log('Setting follow-up mode from current response');
      setFollowUpMode(
        currentPrompt || 'Previous conversation', 
        responseDiv.innerHTML.trim(),
        'general',
        'Follow-up mode - Continue the conversation'
      );
      input.value = '';
      showStatus('Follow-up mode enabled. Your next message will continue this conversation.');
      setTimeout(() => showStatus(''), 2000);
      return;
    }
    
    if (currentPrompt || currentResponse) {
      console.log('Storing prompt and response for follow-up');
      window.rift.storeHistory(currentPrompt, currentResponse)
        .then(() => {
          return window.rift.getHistory(1);
        })
        .then(history => {
          if (history && history.length > 0) {
            input.value = '';
            showStatus('Follow-up mode enabled. Your next message will continue this conversation.');
            setFollowUpMode(
              history[0].prompt, 
              history[0].response,
              'general',
              'Follow-up mode - Continue the conversation'
            );
            
            setTimeout(() => showStatus(''), 2000);
          } else {
            showStatus('No history available for follow-up');
            setTimeout(() => showStatus(''), 1500);
          }
        })
        .catch(err => {
          console.error('Error storing history:', err);
          showStatus('Error storing history', '#ffa0a0');
        });
    } else {
      showStatus('No content to use for follow-up');
      setTimeout(() => showStatus(''), 1500);
    }
  }
  
  // cmd y
  if (e.metaKey && e.key === 'y') {
    e.preventDefault();
    console.log('Cmd+Y pressed, attempting to send email draft');
    if (input.value.trim().match(/\b(draft|write|compose|create|send).+\b(to|for)\s+[^\s@]+@[^\s@]+\.[^\s@]+/i)) {
      console.log('Creating draft from current input before sending');
      routePrompt().then(() => {
        setTimeout(() => {
          window.rift.sendDraft()
            .then(result => {
              if (result.success) {
                showStatus('Email sent successfully!');
                input.value = '';
                showResponse('📤 Email sent successfully!');
                clearFollowUpMode();
              } else {
                showStatus('Failed to send email: ' + (result.error || 'Unknown error'), '#ffa0a0');
              }
            })
            .catch(err => {
              showStatus('Error sending email: ' + err.message, '#ffa0a0');
            });
        }, 1000);
      });
    } else {
      window.rift.sendDraft()
        .then(result => {
          if (result.success) {
            showStatus('Email sent successfully!');
            input.value = '';
            showResponse('📤 Email sent successfully!');
            clearFollowUpMode();
          } else {
            showStatus('Failed to send email: ' + (result.error || 'Unknown error'), '#ffa0a0');
          }
        })
        .catch(err => {
          showStatus('Error sending email: ' + err.message, '#ffa0a0');
        });
    }
  }
});

window.rift.onFocusInput(() => {
  input.focus();
  input.select();
});

function showCalendarProposal(proposal) {
  responseDiv.replaceChildren();
  responseDiv.style.display = 'block';
  const details = document.createElement('pre');
  details.style.whiteSpace = 'pre-wrap';
  const event = proposal.action;
  details.textContent = `Operation: ${proposal.operationId}\nStatus: ${proposal.status}\nCalendar: ${proposal.destination || '(unavailable; make a new proposal)'}\n${event.title}\nStart: ${event.start}\nEnd: ${event.end}\nTimezone: ${event.timeZone}\nLocation: ${event.location || '(none)'}\nDescription: ${event.description || '(none)'}${proposal.reason ? '\n' + proposal.reason : ''}`;
  responseDiv.append(details);
  showStatus(proposal.status === 'proposed' ? 'Review before adding to Google Calendar' : `Calendar operation: ${proposal.status}`);
  if (proposal.status === 'proposed') {
    const buttons = [];
    for (const [label, method] of [['Confirm', 'confirmCalendar'], ['Cancel', 'cancelCalendar']]) {
      const button = document.createElement('button');
      button.textContent = label;
      buttons.push(button);
      button.addEventListener('click', async () => {
        buttons.forEach(b => { b.disabled = true; });
        try {
          const result = await window.rift[method](proposal.operationId, proposal.digest);
          if (result.proposal) showCalendarProposal(result.proposal);
          else showStatus(result.error, '#ffa0a0');
        } catch {
          showStatus('Could not read the outcome. Restart and inspect recorded outcomes before retrying.', '#ffa0a0');
        }
      });
      responseDiv.append(button);
    }
  }
  resizeWindowToFitContent();
}

window.rift.calendarOutcomes().then(records => {
  const interrupted = records.filter(r => r.status === 'uncertain' || r.status === 'stale');
  if (interrupted.length) showCalendarProposal(interrupted.at(-1));
}).catch(() => showStatus('Calendar journal unavailable; writes are blocked.', '#ffa0a0'));
