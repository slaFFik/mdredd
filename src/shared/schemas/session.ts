import { z } from 'zod';
import { EffortSchema, ModeSchema, ModelIdSchema, VariantTypeSchema } from './types.js';
import { defaultEffortForModel } from '../constants.js';

export const ColumnConfigSchema = z.object({
  id: z.string(),
  variantName: z.string(),
  variantType: VariantTypeSchema,
  skillOrAgentName: z.string().nullable(),
  variantContent: z.string(),
  prompt: z.string(),
  model: ModelIdSchema,
  // Null means "omit --effort and let the CLI decide". Optional+default keeps
  // pre-existing session.json files (without this field) parsing cleanly.
  effort: EffortSchema.nullable().optional().default(null),
  currentRunFolder: z.string().nullable(),
});
export type ColumnConfig = z.infer<typeof ColumnConfigSchema>;

// `skillsEnabled` was renamed to `userScopeEnabled`; copy the old key forward
// so existing session.json files keep the user's prior choice.
export const SessionFileSchema = z.preprocess(
  (data) => {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if ('skillsEnabled' in obj && !('userScopeEnabled' in obj)) {
        const { skillsEnabled, ...rest } = obj;
        return { ...rest, userScopeEnabled: skillsEnabled };
      }
    }
    return data;
  },
  z.object({
    mode: ModeSchema,
    judgeEnabled: z.boolean(),
    // Optional+default keeps pre-existing session.json files (without this field) parsing cleanly.
    judgeModel: ModelIdSchema.optional().default('claude-haiku-4-5'),
    userScopeEnabled: z.boolean().optional().default(false),
    defaultModel: ModelIdSchema,
    cwd: z.string(),
    columns: z.array(ColumnConfigSchema).min(1).max(3),
  }),
);
export type SessionFile = z.infer<typeof SessionFileSchema>;

export const MAX_COLUMNS = 3;

export function makeDefaultSession(cwd: string): SessionFile {
  const defaultModel = 'sonnet';
  return {
    mode: 'read-only',
    judgeEnabled: true,
    judgeModel: 'claude-haiku-4-5',
    userScopeEnabled: false,
    defaultModel,
    cwd,
    columns: [makeBlankColumn('col-1', defaultModel), makeBlankColumn('col-2', defaultModel)],
  };
}

export function makeBlankColumn(id: string, model: string): ColumnConfig {
  return {
    id,
    variantName: '',
    variantType: 'CLAUDE.md',
    skillOrAgentName: null,
    variantContent: '',
    prompt: '',
    model,
    effort: defaultEffortForModel(model),
    currentRunFolder: null,
  };
}
