export function summarizeSamples(scenarioIds, samples, results) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error('Samples must be an integer from 1 to 20.');
  if (!Array.isArray(scenarioIds) || !scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length || scenarioIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid scenario plan.');
  const counts = total => ({ passed: 0, failed: 0, runtimeErrors: 0, notRun: total, total });
  const total = counts(scenarioIds.length * samples);
  const byScenario = Object.fromEntries(scenarioIds.map(id => [id, counts(samples)]));
  const seen = new Set();
  for (const result of results) {
    const sample = result.sample ?? 1;
    const key = JSON.stringify([result.scenario, sample]);
    if (!Object.hasOwn(byScenario, result.scenario) || !Number.isInteger(sample) || sample < 1 || sample > samples || seen.has(key)) throw new Error('Unexpected or duplicate sample.');
    const outcomes = { passed: 'passed', failed: 'failed', 'runtime-error': 'runtimeErrors' };
    if (!Object.hasOwn(outcomes, result.outcome)) throw new Error('Unknown sample outcome.');
    const outcome = outcomes[result.outcome];
    seen.add(key);
    for (const target of [total, byScenario[result.scenario]]) { target[outcome]++; target.notRun--; }
  }
  return { total, byScenario };
}
