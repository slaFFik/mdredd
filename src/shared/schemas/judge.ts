import { z } from 'zod';

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

// Shape the Haiku judge must emit as its primary output (enforced via --json-schema).
export const JudgeModelOutputSchema = z.object({
  scores: JudgeScoresSchema,
  rationale: z.string().min(1).max(600),
});
export type JudgeModelOutput = z.infer<typeof JudgeModelOutputSchema>;

// The wrapper we persist to disk. Includes status + metadata around the model's raw scorecard.
export const JudgeFileSchema = z.object({
  runFolder: z.string(),
  createdAt: z.string(),
  judgeModel: z.string(),
  status: z.enum(['ok', 'errored']),
  error: z.string().optional(),
  scores: JudgeScoresSchema.optional(),
  rationale: z.string().optional(),
});
export type JudgeFile = z.infer<typeof JudgeFileSchema>;

// JSON Schema passed to `claude --json-schema` for structured output enforcement at generation time.
export const JUDGE_MODEL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'rationale'],
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
    rationale: { type: 'string', maxLength: 600, minLength: 1 },
  },
} as const;
