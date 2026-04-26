import type { ServerSseEvent } from '@shared/schemas/events.js';
import type { SessionFile } from '@shared/schemas/session.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { JudgeFile } from '@shared/schemas/judge.js';
import type { ColumnStatus } from '@shared/schemas/types.js';
import type { LocalVariantsResponse } from '@shared/schemas/localVariants.js';

export interface StateSnapshot {
  session: SessionFile;
  runs: Record<
    string,
    {
      config: RunConfig;
      transcript: TranscriptFile | null;
      judge: JudgeFile | null;
      outputs: OutputFile[];
    }
  >;
  activeStatuses: Record<string, ColumnStatus>;
}

function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('t') ?? '';
  return t;
}

const TOKEN = getToken();

function url(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}t=${encodeURIComponent(TOKEN)}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    'x-mdredd-token': TOKEN,
  };
  if (init.method && init.method !== 'GET' && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url(path), { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchState(): Promise<StateSnapshot> {
  return request<StateSnapshot>('/api/state');
}

export async function fetchLocalVariants(): Promise<LocalVariantsResponse> {
  return request<LocalVariantsResponse>('/api/local-variants');
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export async function fsList(relPath: string): Promise<{ path: string; entries: FsEntry[] }> {
  return request(`/api/fs/list?path=${encodeURIComponent(relPath)}`);
}

export async function fsRead(
  relPath: string,
): Promise<{ path: string; content: string; size: number }> {
  return request(`/api/fs/read?path=${encodeURIComponent(relPath)}`);
}

export async function patchSession(body: {
  mode?: string;
  judgeEnabled?: boolean;
  defaultModel?: string;
}): Promise<SessionFile> {
  return request<SessionFile>('/api/session', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function patchColumn(
  columnId: string,
  body: Partial<{
    variantName: string;
    variantType: string;
    skillOrAgentName: string | null;
    variantContent: string;
    prompt: string;
    model: string;
  }>,
): Promise<void> {
  await request(`/api/session/columns/${encodeURIComponent(columnId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function runColumn(columnId: string): Promise<{ ok: true; runFolder: string }> {
  return request('/api/run', {
    method: 'POST',
    body: JSON.stringify({ columnId }),
  });
}

export async function stopColumn(columnId: string): Promise<void> {
  await request('/api/stop', {
    method: 'POST',
    body: JSON.stringify({ columnId }),
  });
}

export async function addColumn(): Promise<SessionFile> {
  return request<SessionFile>('/api/columns', { method: 'POST' });
}

export async function removeColumn(columnId: string): Promise<SessionFile> {
  return request<SessionFile>(`/api/columns/${encodeURIComponent(columnId)}`, {
    method: 'DELETE',
  });
}

export async function startNew(): Promise<void> {
  await request('/api/start-new', { method: 'POST' });
}

export type SseHandler = (e: ServerSseEvent) => void;

export function openSseStream(
  onEvent: SseHandler,
  onOpen?: () => void,
  onError?: () => void,
): EventSource {
  const es = new EventSource(url('/sse'));
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as ServerSseEvent;
      onEvent(ev);
    } catch {
      /* ignore malformed */
    }
  };
  if (onOpen) es.onopen = () => onOpen();
  if (onError) es.onerror = () => onError();
  return es;
}
