import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalVariant } from '@shared/schemas/localVariants.js';
import { log } from './log.js';

const MAX_BYTES = 256 * 1024; // cap individual variants to avoid loading huge files into the UI

export async function listLocalSkills(cwd: string): Promise<LocalVariant[]> {
  const dir = join(cwd, '.claude', 'skills');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('localVariants.skills-readdir-failed', { error: (err as Error).message });
    return [];
  }
  const candidates = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const settled = await Promise.all(
    candidates.map(async (entry): Promise<LocalVariant | null> => {
      const skillPath = join(dir, entry.name, 'SKILL.md');
      try {
        const content = await readFile(skillPath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return null;
        return { name: entry.name, content, path: skillPath };
      } catch {
        return null;
      }
    }),
  );
  const out = settled.filter((v): v is LocalVariant => v !== null);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listLocalAgents(cwd: string): Promise<LocalVariant[]> {
  const dir = join(cwd, '.claude', 'agents');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('localVariants.agents-readdir-failed', { error: (err as Error).message });
    return [];
  }
  const candidates = entries.filter(
    (e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'),
  );
  const settled = await Promise.all(
    candidates.map(async (entry): Promise<LocalVariant | null> => {
      const agentPath = join(dir, entry.name);
      try {
        const content = await readFile(agentPath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return null;
        return { name: entry.name.slice(0, -3), content, path: agentPath };
      } catch {
        return null;
      }
    }),
  );
  const out = settled.filter((v): v is LocalVariant => v !== null);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
