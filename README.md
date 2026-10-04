# Rift

Rift tests whether an agent's calendar actions produce the intended result. Its offline environment preserves simulated events across calls and restarts, injects failures such as a lost response after a successful write, and checks the final state for duplicates and unintended changes. Connect an MCP host or run the included action clients. Start with the [agent lab](harness/LAB.md).

```sh
cd harness
npm ci
npm run demo:lab
```

Open the HTML file printed by the demo. It compares a deliberately unsafe retry client with Rift's existing action client across six scenarios. It uses no model or Google account. Expand a failed sample to inspect its checks, initial and final events, and ordered call trace; these scripted results are not measurements of Codex or Claude performance. Run `npm test` to check the implementation separately.

[Recorded Codex and Claude evaluations](harness/evidence/README.md) include three fresh samples per scenario in each host. Both passed all samples of five scenarios and failed all three cases where another meeting appeared after the availability read. Codex reported success after creating an overlapping event; Claude noticed the overlap after writing. The lab rejected both resulting states. The optional `npm run eval:codex` and `npm run eval:claude` runners retain fresh host runs and reports and accept `--samples`. These six fixed tasks do not establish general model success rates.

The [reviewed calendar harness](harness/README.md) also supports Google Calendar through local authentication and explicit terminal review. The Electron application in `app/` provides the desktop features below.

## Features

### Calendar Management
- Propose one event with natural language, review its exact times and timezone, then confirm or cancel
- Query your calendar for upcoming events
- Calendar deletion, modification, Meet writes, and calendar/custom workflows are blocked in the bounded MVP

See [Calendar Reliability](docs/calendar-reliability.md) for the schema, recorded outcomes, limitations, and a 75-second demo.

### Email Management
- View unread emails
- Search emails by subject or sender
- View email content with HTML rendering
- Reply to emails directly from the viewer
- Draft new emails with professional formatting

### Google Meet Management

### Google Drive Management


### Authentication Flow

1. OAuth2 authentication with Google
2. Token storage using keytar for secure credential management
3. Automatic token refresh
4. Re-authentication when tokens expire or become invalid

## Keyboard Shortcuts
- **Cmd+Shift+Space**: Show/hide the app
- **Cmd+Shift+R**: Reset the prompt
- **Cmd+Shift+F**: Store context for follow-up
- **Cmd+Y**: Send email draft

## Technical Details

### Dependencies
- Electron: Desktop application framework
- Google APIs: Calendar and Gmail integration
- Gemini AI: Intent detection and content generation
- Keytar: Secure credential storage

### Authentication
- Uses OAuth2 for Google API authentication
- Stores refresh tokens securely using keytar
- Automatically refreshes access tokens
- Handles re-authentication when needed

### Data Flow
1. User enters a prompt
2. Intent is detected using Gemini AI
3. Prompt is routed to appropriate handler
4. Handler processes the request and returns a response
5. Response is displayed to the user

## Development

### Setup
1. Clone the repository
2. Enter the application directory: `cd rift/app`
3. Install dependencies: `npm ci`
4. Create a local `.env` file with required API keys and credentials
5. Start the app: `npm start`

The calendar tests and fake demo need only Node.js 22 or later. From `app/`, run `npm test` and `npm run demo:calendar`; dependency installation and credentials are unnecessary for these commands.

### Environment Variables
- `GOOGLE_CLIENT_ID`: Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `GOOGLE_API_KEY`: Google API key
- `GEMINI_API_KEY`: Google Gemini API key
- `GEMINI_MODEL`: A supported Gemini model ID for the calendar parser

Environment files are excluded from application packaging. Packaged runs must receive configuration through the launching environment. Do not place credentials in source control or release artifacts.

### Building
- Build for the current platform from `app/`: `npm run build`

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
