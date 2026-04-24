import { z } from 'zod';
import { ModeSchema, ModelIdSchema, VariantTypeSchema } from './types.js';

export const ColumnConfigSchema = z.object({
  id: z.string(),
  variantName: z.string(),
  variantType: VariantTypeSchema,
  skillOrAgentName: z.string().nullable(),
  variantContent: z.string(),
  prompt: z.string(),
  model: ModelIdSchema,
  currentRunFolder: z.string().nullable(),
});
export type ColumnConfig = z.infer<typeof ColumnConfigSchema>;

export const SessionFileSchema = z.object({
  mode: ModeSchema,
  judgeEnabled: z.boolean(),
  defaultModel: ModelIdSchema,
  cwd: z.string(),
  columns: z.array(ColumnConfigSchema).min(1).max(3),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export const MAX_COLUMNS = 3;

export function makeDefaultSession(cwd: string): SessionFile {
  const defaultModel = 'sonnet';
  return {
    mode: 'read-only',
    judgeEnabled: true,
    defaultModel,
    cwd,
    columns: [
      makeBlankColumn('col-1', defaultModel),
      makeBlankColumn('col-2', defaultModel),
    ],
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
    currentRunFolder: null,
  };
}
