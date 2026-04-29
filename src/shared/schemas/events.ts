import { z } from 'zod';
import { RunStatusSchema } from './types.js';

export const NormalizedEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('turn'),
    turn: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('partial'),
    chunk: z.string(),
    kind: z.enum(['text', 'thinking']),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('message'),
    role: z.enum(['assistant', 'user', 'tool']),
    content: z.unknown(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('toolUse'),
    // Anthropic stream tool_use_id (present from real claude and fake-claude;
    // optional for forward-compat with older transcripts written before this
    // field existed).
    id: z.string().optional(),
    tool: z.string(),
    argsSummary: z.string(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('toolResult'),
    // Matches the corresponding toolUse.id; pair by id rather than by parser
    // state so parallel tool calls don't get scrambled.
    id: z.string().optional(),
    tool: z.string(),
    resultSummary: z.string(),
    isError: z.boolean().optional(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('permissionDenied'),
    tool: z.string(),
    path: z.string(),
    ts: z.number().int().nonnegative(),
  }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

export const ServerSseEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('run.started'),
    col: z.string(),
    runFolder: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.turn'),
    col: z.string(),
    turn: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.partial'),
    col: z.string(),
    chunk: z.string(),
    kind: z.enum(['text', 'thinking']),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.message'),
    col: z.string(),
    role: z.enum(['assistant', 'user', 'tool']),
    content: z.unknown(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.toolUse'),
    col: z.string(),
    tool: z.string(),
    argsSummary: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.toolResult'),
    col: z.string(),
    tool: z.string(),
    resultSummary: z.string(),
    isError: z.boolean().optional(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.permissionDenied'),
    col: z.string(),
    tool: z.string(),
    path: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.ended'),
    col: z.string(),
    status: RunStatusSchema,
    reason: z.string().optional(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('run.outputs'),
    col: z.string(),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('judge.started'),
    col: z.string(),
    runFolder: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('judge.updated'),
    col: z.string(),
    // Payload validated separately against JudgeJsonSchema. The payload's
    // runFolder is the source of truth for which run this update belongs to.
    payload: z.unknown(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('judge.errored'),
    col: z.string(),
    runFolder: z.string(),
    error: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('server.heartbeat'),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('column.statusChanged'),
    col: z.string(),
    status: z.string(),
    runFolder: z.string().nullable(),
    seq: z.number().int().nonnegative(),
  }),
]);
export type ServerSseEvent = z.infer<typeof ServerSseEventSchema>;
