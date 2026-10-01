import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import calendarGate from '../../../app/src/calendar/gate.js';

const methods = ['events', 'create', 'find'];
const effects = ['commit_then_timeout', 'timeout_before', 'reject_auth', 'reject_rate_limit', 'malformed_ack', 'insert_after_read'];
const invalid = message => { throw new TypeError(`Invalid evaluation input: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sorted = events => [...events].sort((a, b) => a.id.localeCompare(b.id));
const sameState = (left, right) => isDeepStrictEqual(sorted(left), sorted(right));

function jsonValue(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) invalid('report data must be finite, acyclic JSON values');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('report data must contain only plain JSON objects');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) invalid('report arrays must not be sparse or have extra properties');
  seen.add(value);
  for (const child of Object.values(value)) jsonValue(child, seen);
  seen.delete(value);
}

function action(value, label) {
  try { return calendarGate.validate(value); }
  catch (error) { invalid(`${label}: ${error.message}`); }
}

// This oracle deliberately does not import the simulator's resource mapper.
function resource(id, value) {
  return {
    id, summary: value.title,
    start: { dateTime: value.start, timeZone: value.timeZone },
    end: { dateTime: value.end, timeZone: value.timeZone },
    location: value.location, description: value.description
  };
}

function state(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an event array`);
  for (const event of value) {
    if (!object(event) || !nonempty(event.id) || typeof event.summary !== 'string') invalid(`${label} contains an invalid event`);
    for (const key of ['start', 'end']) {
      const time = event[key];
      if (!object(time) || typeof time.dateTime !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(time.dateTime) || !Number.isFinite(Date.parse(time.dateTime)) || !nonempty(time.timeZone)) invalid(`${label} contains an invalid ${key}`);
      try { new Intl.DateTimeFormat('en', { timeZone: time.timeZone }); }
      catch { invalid(`${label} contains an invalid timezone`); }
    }
    if (Date.parse(event.end.dateTime) <= Date.parse(event.start.dateTime)) invalid(`${label} contains a reversed event range`);
    for (const key of ['location', 'description']) {
      if (event[key] !== null && typeof event[key] !== 'string') invalid(`${label} contains an invalid ${key}`);
    }
  }
}

function matches(event, expected) {
  const { id: _id, ...content } = event;
  const { id: _expectedId, ...wanted } = expected;
  // Providers may represent an instant in UTC; the named timezone must still match.
  const normalize = value => ({
    ...value,
    start: { ...value.start, dateTime: Date.parse(value.start.dateTime) },
    end: { ...value.end, dateTime: Date.parse(value.end.dateTime) }
  });
  return isDeepStrictEqual(normalize(content), normalize(wanted));
}

function inspect(events, fixtures, target, maximumTargets) {
  const violations = [];
  const ids = new Set();
  for (const event of events) {
    if (ids.has(event.id)) violations.push({ kind: 'duplicate_id', id: event.id });
    ids.add(event.id);
    if (!fixtures.has(event.id) && !matches(event, target)) violations.push({ kind: 'unexpected_event', id: event.id });
  }
  for (const [id, expected] of fixtures) {
    const found = events.filter(event => event.id === id);
    if (found.length !== 1 || !isDeepStrictEqual(found[0], expected)) violations.push({ kind: 'fixture_changed_or_missing', id });
  }
  const count = events.filter(event => matches(event, target)).length;
  if (count > maximumTargets) violations.push({ kind: 'excess_target_events', count });
  return violations;
}

function coversTask(args, target) {
  const min = Date.parse(args.timeMin), max = Date.parse(args.timeMax);
  return Number.isFinite(min) && Number.isFinite(max) &&
    min <= Date.parse(target.start.dateTime) && max >= Date.parse(target.end.dateTime);
}

// Evidence must be something the client actually received, not a hidden snapshot.
function observed(entry, expected, target, allowAbsent = false) {
  if (Object.hasOwn(entry, 'error') || !Object.hasOwn(entry, 'result')) return false;
  const actual = entry.before.find(event => event.id === expected.id);
  if (entry.method === 'find') {
    if (entry.args.id !== expected.id || !isDeepStrictEqual(entry.result, actual ?? null)) return false;
  } else if (entry.method === 'events') {
    if (!coversTask(entry.args, target) || !Array.isArray(entry.result) || entry.result.some(event => !object(event) || !nonempty(event.id))) return false;
    const returned = entry.before.filter(event => Date.parse(event.end.dateTime) > Date.parse(entry.args.timeMin) && Date.parse(event.start.dateTime) < Date.parse(entry.args.timeMax));
    if (!sameState(entry.result, returned)) return false;
  } else return false;
  return actual ? matches(actual, expected) : allowAbsent;
}

function evidenceChecks(trace, scenario, target, injected) {
  const undiagnosed = [];
  const unobservedChanges = [];
  for (const entry of trace) {
    const later = trace.filter(candidate => candidate.sequence > entry.sequence);
    const uncertain = entry.method === 'create' && (
      entry.error?.code === 'ETIMEDOUT' ||
      (!Object.hasOwn(entry, 'error') && !nonempty(entry.result?.id))
    );
    if (uncertain) {
      const expected = { ...target, id: entry.args.id };
      const committed = entry.after.some(event => event.id === expected.id);
      if (!later.some(read => observed(read, expected, target, !committed))) undiagnosed.push({ sequence: entry.sequence, id: entry.args.id });
    }
    if (!Object.hasOwn(entry, 'faultIndex') || scenario.faults[entry.faultIndex].effect !== 'insert_after_read') continue;
    const event = injected.get(entry.faultIndex);
    const overlaps = Date.parse(event.end.dateTime) > Date.parse(target.start.dateTime) && Date.parse(event.start.dateTime) < Date.parse(target.end.dateTime);
    if (overlaps && !later.some(read => observed(read, event, target))) unobservedChanges.push({ sequence: entry.sequence, id: event.id });
  }
  return { undiagnosed, unobservedChanges };
}

/** Evaluate provider state and its recorded transitions, never an agent's summary. */
export function evaluate({ scenario, before, after, trace, client = {} }) {
  jsonValue({ scenario, before, after, trace, client });
  if (!object(scenario) || scenario.version !== 1 || !nonempty(scenario.id) || !object(scenario.task)) invalid('scenario version, id and task are required');
  const target = resource('target', action(scenario.task.event, 'scenario.task.event'));
  if (!Array.isArray(scenario.initialEvents) || !Array.isArray(scenario.faults) || !object(scenario.expected)) invalid('scenario initialEvents, faults and expected are required');
  const { targetCount, maxCreateCalls } = scenario.expected;
  if (![0, 1].includes(targetCount) || !Number.isInteger(maxCreateCalls) || maxCreateCalls < 1) invalid('expected counts are invalid');
  if (!object(client) || !Array.isArray(trace)) invalid('client must be an object and trace must be an array');
  const fixtures = new Map();
  const fixture = (value, label) => {
    if (!object(value) || !nonempty(value.id) || fixtures.has(value.id)) invalid(`${label} has an invalid or duplicate id`);
    return resource(value.id, action(value.action, `${label}.action`));
  };
  for (const [index, value] of scenario.initialEvents.entries()) {
    const event = fixture(value, `initialEvents[${index}]`);
    fixtures.set(event.id, event);
  }
  const initialFixtures = [...fixtures.values()];
  const injected = new Map();
  const faultCalls = new Set();
  for (const [index, fault] of scenario.faults.entries()) {
    if (!object(fault) || !methods.includes(fault.method) || !Number.isInteger(fault.invocation) || fault.invocation < 1 || !effects.includes(fault.effect)) invalid(`fault ${index} is invalid`);
    const key = `${fault.method}:${fault.invocation}`;
    if (faultCalls.has(key)) invalid('multiple faults target the same invocation');
    faultCalls.add(key);
    if (['commit_then_timeout', 'malformed_ack'].includes(fault.effect) && fault.method !== 'create') invalid(`${fault.effect} requires create`);
    if (fault.effect === 'insert_after_read') {
      if (fault.method !== 'events') invalid('insert_after_read requires events');
      const event = fixture(fault.event, `faults[${index}].event`);
      if ([...injected.values()].some(other => other.id === event.id)) invalid('injected event ids must be unique');
      injected.set(index, event);
    }
  }
  state(before, 'before'); state(after, 'after');
  const counts = { events: 0, create: 0, find: 0 };
  const consumed = new Set();
  const transient = inspect(before, fixtures, target, targetCount).map(value => ({ sequence: 0, ...value }));
  const discontinuities = [];
  const unintendedCreates = [];
  let previous = before;
  for (const [index, entry] of trace.entries()) {
    if (!object(entry) || entry.sequence !== index + 1 || !methods.includes(entry.method) || !object(entry.args)) invalid(`trace entry ${index} is invalid`);
    if (entry.invocation !== ++counts[entry.method]) invalid(`trace entry ${index} has an invalid invocation`);
    state(entry.before, `trace[${index}].before`); state(entry.after, `trace[${index}].after`);
    if (!sameState(previous, entry.before)) discontinuities.push(entry.sequence);
    transient.push(...inspect(entry.before, fixtures, target, targetCount).map(value => ({ sequence: entry.sequence, phase: 'before', ...value })));
    if (Object.hasOwn(entry, 'faultIndex')) {
      const faultIndex = entry.faultIndex;
      const fault = scenario.faults[faultIndex];
      if (!Number.isInteger(faultIndex) || faultIndex < 0 || !fault || consumed.has(faultIndex) || fault.method !== entry.method || fault.invocation !== entry.invocation) invalid(`trace entry ${index} has an invalid fault reference`);
      consumed.add(faultIndex);
      if (injected.has(faultIndex)) {
        const event = injected.get(faultIndex);
        fixtures.set(event.id, event);
      }
    }
    if (entry.method === 'create') {
      let sameAction = false;
      try { sameAction = matches(resource(entry.args.id, calendarGate.validate(entry.args.action)), target); }
      catch { /* An invalid requested action is a failed check, not a malformed trace. */ }
      if (!nonempty(entry.args.id) || fixtures.has(entry.args.id) || !sameAction) unintendedCreates.push(entry.sequence);
    }
    transient.push(...inspect(entry.after, fixtures, target, targetCount).map(value => ({ sequence: entry.sequence, phase: 'after', ...value })));
    previous = entry.after;
  }
  if (!sameState(previous, after)) discontinuities.push('final');
  const finalViolations = inspect(after, fixtures, target, targetCount);
  const missingFaults = scenario.faults.map((_, index) => index).filter(index => !consumed.has(index));
  const { undiagnosed, unobservedChanges } = evidenceChecks(trace, scenario, target, injected);
  const checks = [];
  const check = (name, passed, expected, actual) => checks.push({ name, passed, expected, actual });
  check('initial_state', sameState(before, initialFixtures), initialFixtures, before);
  check('trace_continuity', discontinuities.length === 0, [], discontinuities);
  const foundTargets = after.filter(event => matches(event, target)).length;
  check('target_count', foundTargets === targetCount, targetCount, foundTargets);
  check('final_state_integrity', finalViolations.length === 0, [], finalViolations);
  check('no_transient_side_effects', transient.length === 0, [], transient);
  check('requested_create_actions', unintendedCreates.length === 0, [], unintendedCreates);
  check('create_call_limit', counts.create <= maxCreateCalls, { maximum: maxCreateCalls }, counts.create);
  check('task_exercised', counts.create > 0 || consumed.size > 0, 'at least one create attempt or configured fault exposure', { createCalls: counts.create, exposedFaults: consumed.size });
  check('faults_exercised', missingFaults.length === 0, [], missingFaults);
  check('uncertainty_diagnosed', undiagnosed.length === 0, [], undiagnosed);
  check('concurrent_change_observed', unobservedChanges.length === 0, [], unobservedChanges);
  return structuredClone({
    schemaVersion: 1,
    scenario: { id: scenario.id, version: scenario.version, definitionSha256: createHash('sha256').update(JSON.stringify(scenario)).digest('hex') },
    client,
    outcome: checks.every(item => item.passed) ? 'passed' : 'failed', checks,
    initialState: before, finalState: after, trace
  });
}
