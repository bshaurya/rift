import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateHost, evaluationExitCode, labPrompt, labScript, labTools } from '../src/lab/host-runner.js';

export function claudeInvocation({ run, model, reasoning }) {
  const config = { mcpServers: { rift_lab: { command: process.execPath, args: [labScript, 'serve', '--run', run] } } };
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), '--disable-slash-commands', '--tools', '', '--allowedTools', labTools.map(name => `mcp__rift_lab__${name}`).join(','), '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--no-chrome', '--permission-mode', 'dontAsk', '--effort', reasoning];
  if (model !== 'cli-default') args.push('--model', model);
  args.push(labPrompt);
  return { args };
}

export function inspectClaude(directory) {
  const messages = fs.readFileSync(path.join(directory, 'host.jsonl'), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const init = messages.find(message => message.type === 'system' && message.subtype === 'init');
  const result = messages.findLast(message => message.type === 'result');
  if (!init?.model || !result) throw new Error('Missing model or completion record.');
  return {
    resolvedModel: init.model,
    tools: init.tools,
    mcpServers: init.mcp_servers,
    resultSubtype: result.subtype,
    resultError: result.is_error || result.subtype !== 'success' || !init.mcp_servers?.some(server => server.name === 'rift_lab' && server.status === 'connected')
  };
}

export async function evaluateClaude({ directory, model = 'cli-default', reasoning = 'medium', claude = 'claude', timeoutMs = 180000 }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('Provide a model ID or omit --model for the CLI default.');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning)) throw new Error('Invalid effort.');
  return evaluateHost({ directory, model, reasoning, executable: claude, host: 'Claude', timeoutMs, buildInvocation: claudeInvocation, inspectHost: inspectClaude });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, model: { type: 'string', default: 'cli-default' }, reasoning: { type: 'string', default: 'medium' }, claude: { type: 'string', default: 'claude' }, 'timeout-ms': { type: 'string', default: '180000' } } });
  if (!values.out) throw new Error('--out is required. Choose a fresh directory.');
  evaluateClaude({ directory: path.resolve(values.out), model: values.model, reasoning: values.reasoning, claude: values.claude, timeoutMs: Number(values['timeout-ms']) }).then(summary => { process.exitCode = evaluationExitCode(summary); }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
