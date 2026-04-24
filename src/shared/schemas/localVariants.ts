import { z } from 'zod';

export const LocalVariantSchema = z.object({
  name: z.string(),
  content: z.string(),
  path: z.string(),
});
export type LocalVariant = z.infer<typeof LocalVariantSchema>;

export const LocalVariantsResponseSchema = z.object({
  skills: z.array(LocalVariantSchema),
  agents: z.array(LocalVariantSchema),
});
export type LocalVariantsResponse = z.infer<typeof LocalVariantsResponseSchema>;
