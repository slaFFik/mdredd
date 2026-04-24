import { z } from 'zod';

export const ModeSchema = z.enum(['read-only', 'write']);
export type Mode = z.infer<typeof ModeSchema>;

export const VariantTypeSchema = z.enum(['CLAUDE.md', 'skill', 'agent']);
export type VariantType = z.infer<typeof VariantTypeSchema>;

export const RunStatusSchema = z.enum([
  'preparing',
  'streaming',
  'completed',
  'cancelled',
  'truncated',
  'errored',
  'abandoned',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ColumnStatusSchema = z.enum([
  'idle',
  'preparing',
  'streaming',
  'completed',
  'cancelled',
  'truncated',
  'errored',
  'abandoned',
]);
export type ColumnStatus = z.infer<typeof ColumnStatusSchema>;

export const TruncationReasonSchema = z.enum(['turns', 'wallclock']).nullable();
export type TruncationReason = z.infer<typeof TruncationReasonSchema>;

export const ModelIdSchema = z.string().min(1);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  'completed',
  'cancelled',
  'truncated',
  'errored',
  'abandoned',
];

export const TERMINAL_COLUMN_STATUSES: ColumnStatus[] = [
  'idle',
  ...TERMINAL_RUN_STATUSES,
];

export function isTerminalColumnStatus(s: ColumnStatus): boolean {
  return TERMINAL_COLUMN_STATUSES.includes(s);
}

export function isTerminalRunStatus(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}
