import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalVariant } from '@shared/schemas/localVariants.js';
import { log } from './log.js';

const MAX_BYTES = 256 * 1024; // cap individual variants to avoid loading huge files into the UI

export async function listLocalSkills(cwd: string): Promise<LocalVariant[]> {
  const dir = join(cwd, '.claude', 'skills');
  const out: LocalVariant[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    log.warn('localVariants.skills-readdir-failed', { error: (err as Error).message });
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    try {
      const content = await readFile(skillPath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) continue;
      out.push({ name: entry.name, content, path: skillPath });
    } catch {
      // no SKILL.md in this dir — skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listLocalAgents(cwd: string): Promise<LocalVariant[]> {
  const dir = join(cwd, '.claude', 'agents');
  const out: LocalVariant[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    log.warn('localVariants.agents-readdir-failed', { error: (err as Error).message });
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
    const agentPath = join(dir, entry.name);
    try {
      const content = await readFile(agentPath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) continue;
      const name = entry.name.slice(0, -3);
      out.push({ name, content, path: agentPath });
    } catch {
      // skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
