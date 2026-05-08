import { z } from 'zod';
import {
  JUDGE_RATIONALE_PER_CRITERION_MAX,
  JUDGE_RATIONALE_UMBRELLA_MAX,
  JUDGE_WARNING_MESSAGE_MAX,
} from '../constants.js';
import { TokenUsageSchema } from './run.js';

export const RUBRIC_BANDS = [0, 25, 50, 75, 100] as const;
export type RubricBand = (typeof RUBRIC_BANDS)[number];

export const RubricBandSchema = z.union([
  z.literal(0),
  z.literal(25),
  z.literal(50),
  z.literal(75),
  z.literal(100),
]);

export const JudgeScoresSchema = z.object({
  accuracy: RubricBandSchema,
  completeness: RubricBandSchema,
  adherence: RubricBandSchema,
  clarity: RubricBandSchema,
});
export type JudgeScores = z.infer<typeof JudgeScoresSchema>;

export const ScoreRationalesSchema = z.object({
  accuracy: z.string().min(1).max(JUDGE_RATIONALE_PER_CRITERION_MAX),
  completeness: z.string().min(1).max(JUDGE_RATIONALE_PER_CRITERION_MAX),
  adherence: z.string().min(1).max(JUDGE_RATIONALE_PER_CRITERION_MAX),
  clarity: z.string().min(1).max(JUDGE_RATIONALE_PER_CRITERION_MAX),
});
export type ScoreRationales = z.infer<typeof ScoreRationalesSchema>;

// Per-criterion sentinel: when true, the UI treats the corresponding score as
// N/A (rendered as an em-dash). Lets the judge say "harness limit prevented
// verification" without forcing an arbitrary low band.
export const UngradeableSchema = z.object({
  accuracy: z.boolean().optional(),
  completeness: z.boolean().optional(),
  adherence: z.boolean().optional(),
  clarity: z.boolean().optional(),
});
export type Ungradeable = z.infer<typeof UngradeableSchema>;

// Shape the Haiku judge must emit as its primary output (enforced via --json-schema).
export const JudgeModelOutputSchema = z.object({
  scores: JudgeScoresSchema,
  scoreRationales: ScoreRationalesSchema,
  // The prior 600-char cap routinely truncated the umbrella when 2–3 criteria
  // were ungradeable and the rationale carried most of the explanation; the
  // current value (JUDGE_RATIONALE_UMBRELLA_MAX) doubles that without bloating
  // the prompt.
  rationale: z.string().min(1).max(JUDGE_RATIONALE_UMBRELLA_MAX),
  ungradeable: UngradeableSchema.optional(),
});
export type JudgeModelOutput = z.infer<typeof JudgeModelOutputSchema>;

// Self-consistency warning (M6). Surfaced when the judge emits a perfect score
// alongside rationale text that describes a real gap, or a near-zero score
// alongside praise. The wider per-criterion bands ("75 not 100 because did not
// X") are deliberately NOT flagged: that's exactly the rubric's prescribed
// shape, where the gap explains the chosen band. We only flag the extremes.
export const JudgeWarningKindSchema = z.enum(['high-score-with-gap', 'low-score-with-praise']);
export type JudgeWarningKind = z.infer<typeof JudgeWarningKindSchema>;

export const JudgeWarningSchema = z.object({
  criterion: z.enum(['accuracy', 'completeness', 'adherence', 'clarity']),
  kind: JudgeWarningKindSchema,
  message: z.string().min(1).max(JUDGE_WARNING_MESSAGE_MAX),
});
export type JudgeWarning = z.infer<typeof JudgeWarningSchema>;

// The wrapper we persist to disk. Includes status + metadata around the model's raw scorecard.
// scoreRationales is optional so judge.json files written before the field existed still load.
// tokenUsage / costUsd are optional + nullable so older judge.json files (written before the
// envelope was parsed for usage) still load.
export const JudgeFileSchema = z.object({
  runFolder: z.string(),
  createdAt: z.string(),
  judgeModel: z.string(),
  status: z.enum(['ok', 'errored']),
  error: z.string().optional(),
  scores: JudgeScoresSchema.optional(),
  scoreRationales: ScoreRationalesSchema.optional(),
  rationale: z.string().optional(),
  ungradeable: UngradeableSchema.optional(),
  tokenUsage: TokenUsageSchema.nullable().optional(),
  costUsd: z.number().nullable().optional(),
  warnings: z.array(JudgeWarningSchema).optional(),
});
export type JudgeFile = z.infer<typeof JudgeFileSchema>;

// Per-attempt observability record. Persisted to `judge.attempts.json` next to
// `judge.json` so a bad score can be debugged after the fact without re-running.
// Captures *what was sent* (prompt bytes per section, caps, model+effort) and
// *what came back* (result kind), but never the raw response — the canary value
// is hashed to stay greppable across logs without leaking the secret itself.
// Possible per-attempt outcomes. `spawn_error` covers failures BEFORE the
// model produced output — ENOENT on the binary, non-zero exit, IO errors —
// so the attempts file still records that an attempt was started even when
// the subprocess never reached the parsing stage.
export const JudgeAttemptResultSchema = z.enum([
  'ok',
  'parse_failure',
  'timeout',
  'canary_leak',
  'spawn_error',
]);
export type JudgeAttemptResultKind = z.infer<typeof JudgeAttemptResultSchema>;

export const JudgeAttemptSectionBytesSchema = z.object({
  rubric: z.number().int().nonnegative(),
  variantBody: z.number().int().nonnegative(),
  finalMessage: z.number().int().nonnegative(),
  toolSummary: z.number().int().nonnegative(),
  outputs: z.number().int().nonnegative().optional(),
});
export type JudgeAttemptSectionBytes = z.infer<typeof JudgeAttemptSectionBytesSchema>;

export const JudgeAttemptSchema = z.object({
  label: z.literal('first'),
  model: z.string(),
  // Effort flag actually passed to spawnJudge. `null` means --effort was omitted
  // (e.g. Haiku, no effort menu). Stringified so future effort levels load on
  // older clients without a schema bump.
  effort: z.string().nullable(),
  promptTotalBytes: z.number().int().nonnegative(),
  sectionBytes: JudgeAttemptSectionBytesSchema,
  // SHA-256 of the canary token. Lets us correlate a leaked canary across logs
  // without persisting the secret itself.
  canaryHashSha256: z.string(),
  result: JudgeAttemptResultSchema,
});
export type JudgeAttempt = z.infer<typeof JudgeAttemptSchema>;

export const JudgeAttemptsFileSchema = z.object({
  runFolder: z.string(),
  createdAt: z.string(),
  attempts: z.array(JudgeAttemptSchema),
});
export type JudgeAttemptsFile = z.infer<typeof JudgeAttemptsFileSchema>;

// JSON Schema passed to `claude --json-schema` for structured output enforcement at generation time.
export const JUDGE_MODEL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'scoreRationales', 'rationale'],
  properties: {
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['accuracy', 'completeness', 'adherence', 'clarity'],
      properties: {
        accuracy: { type: 'integer', enum: [0, 25, 50, 75, 100] },
        completeness: { type: 'integer', enum: [0, 25, 50, 75, 100] },
        adherence: { type: 'integer', enum: [0, 25, 50, 75, 100] },
        clarity: { type: 'integer', enum: [0, 25, 50, 75, 100] },
      },
    },
    scoreRationales: {
      type: 'object',
      additionalProperties: false,
      required: ['accuracy', 'completeness', 'adherence', 'clarity'],
      properties: {
        accuracy: { type: 'string', maxLength: JUDGE_RATIONALE_PER_CRITERION_MAX, minLength: 1 },
        completeness: {
          type: 'string',
          maxLength: JUDGE_RATIONALE_PER_CRITERION_MAX,
          minLength: 1,
        },
        adherence: { type: 'string', maxLength: JUDGE_RATIONALE_PER_CRITERION_MAX, minLength: 1 },
        clarity: { type: 'string', maxLength: JUDGE_RATIONALE_PER_CRITERION_MAX, minLength: 1 },
      },
    },
    rationale: { type: 'string', maxLength: JUDGE_RATIONALE_UMBRELLA_MAX, minLength: 1 },
    ungradeable: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accuracy: { type: 'boolean' },
        completeness: { type: 'boolean' },
        adherence: { type: 'boolean' },
        clarity: { type: 'boolean' },
      },
    },
  },
} as const;
