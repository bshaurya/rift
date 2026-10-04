import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateHost, evaluationExitCode, labPrompt, labScript } from '../src/lab/host-runner.js';

const disabledFeatures = ['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins', 'hooks', 'computer_use', 'browser_use', 'workspace_dependencies', 'image_generation', 'in_app_browser', 'memories'];
export function codexInvocation({ workspace, run, model, reasoning }) {
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '-C', workspace, '--model', model, '-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`, '-c', 'web_search="disabled"'];
  for (const feature of disabledFeatures) args.push('--disable', feature);
  args.push('-c', `mcp_servers.rift_lab.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.rift_lab.args=${JSON.stringify([labScript, 'serve', '--run', run])}`, '-c', 'mcp_servers.rift_lab.required=true', '-c', 'mcp_servers.rift_lab.default_tools_approval_mode="auto"', labPrompt);
  return { args };
}
export async function evaluateCodex({ directory, model, reasoning = 'medium', codex = 'codex', timeoutMs = 180000, samples = 1 }) {
  if (!model?.trim()) throw new Error('--model is required. Choose a model supported by your installed CLI and account.');
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw new Error('Invalid reasoning effort.');
  return evaluateHost({ directory, model, reasoning, executable: codex, host: 'Codex', timeoutMs, samples, buildInvocation: codexInvocation });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, model: { type: 'string' }, reasoning: { type: 'string', default: 'medium' }, codex: { type: 'string', default: 'codex' }, samples: { type: 'string', default: '1' }, 'timeout-ms': { type: 'string', default: '180000' } } });
  if (!values.out) throw new Error('--out is required. Choose a fresh directory.');
  evaluateCodex({ directory: path.resolve(values.out), model: values.model, reasoning: values.reasoning, codex: values.codex, timeoutMs: Number(values['timeout-ms']), samples: Number(values.samples) }).then(summary => {
    process.exitCode = evaluationExitCode(summary);
  }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
