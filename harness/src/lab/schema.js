import { z } from 'zod';
import calendarGate from '../../../app/src/calendar/gate.js';
import { validateRange } from '../operations.js';

const nonempty = maximum => z.string().max(maximum).refine(value => value.trim().length > 0, 'Must not be blank.');
export const eventIdSchema = nonempty(200);

// Keep the lab's accepted action contract identical to the existing calendar gate.
export const actionSchema = z.object({
  action: z.literal('create'),
  title: nonempty(200),
  start: z.string(),
  end: z.string(),
  timeZone: z.string(),
  location: z.string().max(2000).nullable(),
  description: z.string().max(2000).nullable(),
  recurrence: z.null(),
  attendees: z.array(z.string()).max(0),
  ambiguities: z.array(z.string()).max(0)
}).strict().superRefine((value, context) => {
  try { calendarGate.validate(value); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error.message }); }
});

export const rangeSchema = z.object({
  timeMin: z.string(), timeMax: z.string(), timeZone: z.string()
}).strict().superRefine((value, context) => {
  try { validateRange(value); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error.message }); }
});

const fixtureSchema = z.object({ id: eventIdSchema, action: actionSchema }).strict();
const faultSchema = z.object({
  method: z.enum(['events', 'create', 'find']),
  invocation: z.number().int().positive(),
  effect: z.enum(['commit_then_timeout', 'timeout_before', 'reject_auth', 'reject_rate_limit', 'malformed_ack', 'insert_after_read']),
  event: fixtureSchema.optional()
}).strict().superRefine((fault, context) => {
  if (['commit_then_timeout', 'malformed_ack'].includes(fault.effect) && fault.method !== 'create') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['effect'], message: 'This effect requires the create method.' });
  }
  if (fault.effect === 'insert_after_read') {
    if (fault.method !== 'events' || !fault.event) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['effect'], message: 'insert_after_read requires events and an event fixture.' });
    }
  } else if (fault.event !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event'], message: 'Only insert_after_read accepts an event fixture.' });
  }
});

export const scenarioSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'Use a short lowercase scenario ID without path separators.'),
  description: nonempty(2000),
  task: z.object({ instruction: nonempty(8000), event: actionSchema }).strict(),
  initialEvents: z.array(fixtureSchema).max(1000),
  faults: z.array(faultSchema).max(1000),
  expected: z.object({ targetCount: z.union([z.literal(0), z.literal(1)]), maxCreateCalls: z.number().int().positive() }).strict()
}).strict().superRefine((scenario, context) => {
  const ids = new Set();
  const rememberId = (id, path) => {
    if (ids.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Event fixture IDs must be unique, including injected events.' });
    ids.add(id);
  };
  scenario.initialEvents.forEach((event, index) => rememberId(event.id, ['initialEvents', index, 'id']));
  const triggers = new Set();
  scenario.faults.forEach((fault, index) => {
    const trigger = `${fault.method}:${fault.invocation}`;
    if (triggers.has(trigger)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['faults', index], message: 'Each method invocation may have only one fault.' });
    triggers.add(trigger);
    if (fault.event) rememberId(fault.event.id, ['faults', index, 'event', 'id']);
  });
});
