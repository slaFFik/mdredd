import { z } from 'zod';
import {
  EffortSchema,
  ModeSchema,
  ModelIdSchema,
  RunStatusSchema,
  TruncationReasonSchema,
  VariantTypeSchema,
} from './types.js';
import { NormalizedEventSchema } from './events.js';

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const RunConfigSchema = z.object({
  runFolder: z.string(),
  columnId: z.string(),
  variantName: z.string(),
  variantType: VariantTypeSchema,
  skillOrAgentName: z.string().nullable(),
  variantContentSha256: z.string(),
  promptSha256: z.string(),
  prompt: z.string(),
  model: ModelIdSchema,
  // Concrete model identifier the CLI reports in its `system_init` event.
  // `model` above is what the user selected (often an alias like `haiku`);
  // this captures what actually ran, so reruns across an alias bump remain
  // comparable. Optional/nullable for back-compat with pre-existing configs.
  resolvedModel: ModelIdSchema.nullable().optional(),
  // Reasoning effort passed to `claude --effort`. Null means the flag was
  // omitted (CLI default). Optional+default keeps historical run configs
  // (written before this field existed) parsing cleanly.
  effort: EffortSchema.nullable().optional().default(null),
  mode: ModeSchema,
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  truncationReason: TruncationReasonSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  errorMessage: z.string().nullable(),
  toolAllowlist: z.array(z.string()),
  caps: z.object({
    turns: z.number().int().positive(),
    wallClockMs: z.number().int().positive(),
  }),
  tokenUsage: TokenUsageSchema.nullable().optional(),
  costUsd: z.number().nullable().optional(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const TranscriptFileSchema = z.object({
  runFolder: z.string(),
  events: z.array(NormalizedEventSchema),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  truncationReason: TruncationReasonSchema,
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export const OutputFileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type OutputFile = z.infer<typeof OutputFileSchema>;
