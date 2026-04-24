import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ServerSseEvent } from '@shared/schemas/events.js';
import type { ColumnConfig, SessionFile } from '@shared/schemas/session.js';
import type { ColumnStatus } from '@shared/schemas/types.js';
import type { JudgeFile } from '@shared/schemas/judge.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { LocalVariantsResponse } from '@shared/schemas/localVariants.js';
import {
  addColumn,
  fetchLocalVariants,
  fetchState,
  openSseStream,
  patchColumn,
  patchSession,
  removeColumn,
  runColumn,
  startNew,
  stopColumn,
  type StateSnapshot,
} from './lib/api.js';
import { VariantColumn } from './components/VariantColumn.js';
import { Footer, REPO_URL } from './components/Footer.js';

type LiveEvent =
  | { kind: 'partial'; streamKind: 'text' | 'thinking'; chunk: string }
  | { kind: 'tool-use'; tool: string; argsSummary: string }
  | { kind: 'tool-result'; tool: string; resultSummary: string; isError?: boolean }
  | { kind: 'permission-denied'; tool: string; path: string }
  | { kind: 'turn'; turn: number; elapsedMs: number };

export interface ColumnLiveState {
  events: LiveEvent[];
  turnCount: number;
  tookMs: number;
  startedAt: number | null;
  lastTool: string | null;
}

export interface AppState {
  loaded: boolean;
  session: SessionFile | null;
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
  live: Record<string, ColumnLiveState>;
  connecting: boolean;
  error: string | null;
  confirmStartNew: boolean;
  confirmRemoveColumnId: string | null;
}

type Action =
  | { type: 'snapshot'; payload: StateSnapshot }
  | { type: 'sse'; event: ServerSseEvent }
  | { type: 'session-patched'; payload: SessionFile }
  | { type: 'patch-column-local'; columnId: string; patch: Partial<ColumnConfig> }
  | { type: 'error'; message: string }
  | { type: 'clear-error' }
  | { type: 'set-confirm-start-new'; open: boolean }
  | { type: 'set-confirm-remove-column'; columnId: string | null }
  | { type: 'set-connecting'; value: boolean };

function emptyLive(): ColumnLiveState {
  return { events: [], turnCount: 0, tookMs: 0, startedAt: null, lastTool: null };
}

function initialState(): AppState {
  return {
    loaded: false,
    session: null,
    runs: {},
    activeStatuses: {},
    live: {},
    connecting: true,
    error: null,
    confirmStartNew: false,
    confirmRemoveColumnId: null,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'snapshot': {
      const live: Record<string, ColumnLiveState> = { ...state.live };
      for (const c of action.payload.session.columns) {
        if (!live[c.id]) live[c.id] = emptyLive();
      }
      return {
        ...state,
        loaded: true,
        session: action.payload.session,
        runs: action.payload.runs,
        activeStatuses: action.payload.activeStatuses,
        live,
        connecting: false,
        error: null,
      };
    }
    case 'session-patched':
      return { ...state, session: action.payload };
    case 'patch-column-local': {
      if (!state.session) return state;
      return {
        ...state,
        session: {
          ...state.session,
          columns: state.session.columns.map((c) =>
            c.id === action.columnId ? { ...c, ...action.patch } : c,
          ),
        },
      };
    }
    case 'sse':
      return applySse(state, action.event);
    case 'error':
      return { ...state, error: action.message };
    case 'clear-error':
      return { ...state, error: null };
    case 'set-confirm-start-new':
      return { ...state, confirmStartNew: action.open };
    case 'set-confirm-remove-column':
      return { ...state, confirmRemoveColumnId: action.columnId };
    case 'set-connecting':
      return { ...state, connecting: action.value };
  }
}

function applySse(state: AppState, event: ServerSseEvent): AppState {
  switch (event.t) {
    case 'run.started': {
      const live = { ...state.live, [event.col]: { ...emptyLive(), startedAt: Date.now() } };
      const session = state.session
        ? {
            ...state.session,
            columns: state.session.columns.map((c) =>
              c.id === event.col ? { ...c, currentRunFolder: event.runFolder } : c,
            ),
          }
        : state.session;
      return { ...state, live, session };
    }
    case 'run.turn': {
      const cur = state.live[event.col] ?? emptyLive();
      const elapsedMs = cur.startedAt ? Date.now() - cur.startedAt : 0;
      return {
        ...state,
        live: {
          ...state.live,
          [event.col]: {
            ...cur,
            turnCount: event.turn,
            events: [...cur.events, { kind: 'turn', turn: event.turn, elapsedMs }],
          },
        },
      };
    }
    case 'run.partial': {
      const cur = state.live[event.col] ?? emptyLive();
      const last = cur.events[cur.events.length - 1];
      // Collapse consecutive partials of the same kind for rendering cheapness.
      let events = cur.events;
      if (last && last.kind === 'partial' && last.streamKind === event.kind) {
        events = cur.events.slice(0, -1).concat({
          kind: 'partial',
          streamKind: event.kind,
          chunk: last.chunk + event.chunk,
        });
      } else {
        events = [...cur.events, { kind: 'partial', streamKind: event.kind, chunk: event.chunk }];
      }
      return {
        ...state,
        live: { ...state.live, [event.col]: { ...cur, events } },
      };
    }
    case 'run.toolUse': {
      const cur = state.live[event.col] ?? emptyLive();
      return {
        ...state,
        live: {
          ...state.live,
          [event.col]: {
            ...cur,
            lastTool: event.tool,
            events: [
              ...cur.events,
              { kind: 'tool-use', tool: event.tool, argsSummary: event.argsSummary },
            ],
          },
        },
      };
    }
    case 'run.toolResult': {
      const cur = state.live[event.col] ?? emptyLive();
      return {
        ...state,
        live: {
          ...state.live,
          [event.col]: {
            ...cur,
            events: [
              ...cur.events,
              {
                kind: 'tool-result',
                tool: event.tool,
                resultSummary: event.resultSummary,
                isError: event.isError,
              },
            ],
          },
        },
      };
    }
    case 'run.permissionDenied': {
      const cur = state.live[event.col] ?? emptyLive();
      return {
        ...state,
        live: {
          ...state.live,
          [event.col]: {
            ...cur,
            events: [
              ...cur.events,
              { kind: 'permission-denied', tool: event.tool, path: event.path },
            ],
          },
        },
      };
    }
    case 'run.ended': {
      return {
        ...state,
        activeStatuses: { ...state.activeStatuses, [event.col]: event.status },
      };
    }
    case 'run.outputs': {
      // Fold outputs into the runs map if we can find the run folder.
      const sessionCol = state.session?.columns.find((c) => c.id === event.col);
      const runFolder = sessionCol?.currentRunFolder;
      if (!runFolder || !state.runs[runFolder]) return state;
      const bundle = state.runs[runFolder];
      return {
        ...state,
        runs: {
          ...state.runs,
          [runFolder]: { ...bundle, outputs: event.files },
        },
      };
    }
    case 'judge.started':
      return state;
    case 'judge.updated': {
      const payload = event.payload as JudgeFile;
      const existing = state.runs[payload.runFolder];
      if (!existing) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [payload.runFolder]: { ...existing, judge: payload },
        },
      };
    }
    case 'judge.errored': {
      return state;
    }
    case 'column.statusChanged':
      return {
        ...state,
        activeStatuses: {
          ...state.activeStatuses,
          [event.col]: event.status as ColumnStatus,
        },
        session: state.session
          ? {
              ...state.session,
              columns: state.session.columns.map((c) =>
                c.id === event.col ? { ...c, currentRunFolder: event.runFolder ?? c.currentRunFolder } : c,
              ),
            }
          : state.session,
      };
    case 'server.heartbeat':
      return state;
    default:
      return state;
  }
}

function anyNonTerminal(statuses: Record<string, ColumnStatus>): boolean {
  return Object.values(statuses).some((s) => s === 'preparing' || s === 'streaming');
}

const EMPTY_LOCAL_VARIANTS: LocalVariantsResponse = { skills: [], agents: [] };

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [localVariants, setLocalVariants] = useState<LocalVariantsResponse>(EMPTY_LOCAL_VARIANTS);
  const esRef = useRef<EventSource | null>(null);

  const loadLocalVariants = useCallback(async () => {
    try {
      const lv = await fetchLocalVariants();
      setLocalVariants(lv);
    } catch {
      // non-fatal — the user just sees an empty picker
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [snap] = await Promise.all([fetchState(), loadLocalVariants()]);
      dispatch({ type: 'snapshot', payload: snap });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [loadLocalVariants]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!state.loaded) return;
    const es = openSseStream(
      (event) => {
        dispatch({ type: 'sse', event });
        // When a run finishes, pull the fresh bundle so the final turn/time/status
        // appear in the column footer (they come from the run's on-disk config).
        if (event.t === 'run.ended') {
          void loadAll();
        }
      },
      () => dispatch({ type: 'set-connecting', value: false }),
      () => {
        dispatch({ type: 'set-connecting', value: true });
        // EventSource auto-reconnects; also re-fetch state after a short delay.
        setTimeout(() => void loadAll(), 2000);
      },
    );
    esRef.current = es;
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [state.loaded, loadAll]);

  // Only blocks Start New (which needs to wipe everything) — individual columns run independently.
  const anyRunning = useMemo(() => anyNonTerminal(state.activeStatuses), [state.activeStatuses]);

  const onPatchColumn = useCallback(
    async (columnId: string, patch: Partial<ColumnConfig>) => {
      // Optimistic local update — avoids server round-trip latency on every keystroke,
      // which would otherwise reset textarea cursor positions.
      dispatch({ type: 'patch-column-local', columnId, patch });
      try {
        await patchColumn(columnId, patch as Record<string, unknown>);
      } catch (err) {
        dispatch({ type: 'error', message: (err as Error).message });
        // On error, reconcile with server state so user isn't stuck with a bad optimistic edit.
        await loadAll();
      }
    },
    [loadAll],
  );

  const onRun = useCallback(
    async (columnId: string) => {
      try {
        await runColumn(columnId);
      } catch (err) {
        dispatch({ type: 'error', message: (err as Error).message });
      }
    },
    [],
  );

  const onStop = useCallback(async (columnId: string) => {
    try {
      await stopColumn(columnId);
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, []);

  const onAddColumn = useCallback(async () => {
    try {
      const s = await addColumn();
      dispatch({ type: 'session-patched', payload: s });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, []);

  const onRequestRemoveColumn = useCallback((columnId: string) => {
    dispatch({ type: 'set-confirm-remove-column', columnId });
  }, []);

  const onConfirmRemoveColumn = useCallback(async () => {
    const columnId = state.confirmRemoveColumnId;
    dispatch({ type: 'set-confirm-remove-column', columnId: null });
    if (!columnId) return;
    try {
      const s = await removeColumn(columnId);
      dispatch({ type: 'session-patched', payload: s });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [state.confirmRemoveColumnId]);

  const onToggleMode = useCallback(async () => {
    if (!state.session) return;
    try {
      const next = state.session.mode === 'read-only' ? 'write' : 'read-only';
      const s = await patchSession({ mode: next });
      dispatch({ type: 'session-patched', payload: s });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [state.session]);

  const onToggleJudge = useCallback(async () => {
    if (!state.session) return;
    try {
      const s = await patchSession({ judgeEnabled: !state.session.judgeEnabled });
      dispatch({ type: 'session-patched', payload: s });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [state.session]);

  const onStartNewConfirm = useCallback(async () => {
    dispatch({ type: 'set-confirm-start-new', open: false });
    try {
      await startNew();
      await loadAll();
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, [loadAll]);

  if (!state.loaded) {
    return <div className="empty-hint">{state.connecting ? 'Loading…' : 'Not loaded.'}</div>;
  }

  const session = state.session!;

  return (
    <>
      <div className="topbar">
        <a
          className="brand"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="MDredd on GitHub"
        >
          MDredd
        </a>
        <button
          className="chip"
          aria-pressed={session.mode === 'write'}
          onClick={onToggleMode}
          title="Toggle write mode (applies to new runs; current runs keep their original mode)"
        >
          Mode: {session.mode === 'write' ? 'Write' : 'Read-only'}
        </button>
        <button
          className="chip"
          aria-pressed={session.judgeEnabled}
          onClick={onToggleJudge}
          title="Toggle judge (applies to new runs; current runs keep their original setting)"
        >
          Judge {session.judgeEnabled ? 'ON' : 'OFF'}
        </button>
        <span className="spacer" />
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {session.cwd}
        </span>
        <button
          className="chip"
          onClick={() => dispatch({ type: 'set-confirm-start-new', open: true })}
          disabled={anyRunning}
          title={anyRunning ? 'Stop all running columns before starting new' : 'Wipe session and all runs'}
        >
          Start new
        </button>
      </div>

      {state.error && (
        <div className="error-banner">
          {state.error}
          <button onClick={() => dispatch({ type: 'clear-error' })}>dismiss</button>
        </div>
      )}

      <div className="columns">
        {session.columns.map((col) => (
          <VariantColumn
            key={col.id}
            column={col}
            status={state.activeStatuses[col.id] ?? 'idle'}
            live={state.live[col.id] ?? emptyLive()}
            runBundle={col.currentRunFolder ? state.runs[col.currentRunFolder] ?? null : null}
            canRemove={session.columns.length > 1}
            mode={session.mode}
            localVariants={localVariants}
            onReloadLocalVariants={loadLocalVariants}
            onPatchColumn={onPatchColumn}
            onRun={onRun}
            onStop={onStop}
            onRemove={onRequestRemoveColumn}
          />
        ))}
        {session.columns.length < 3 && (
          <button className="add-column" onClick={onAddColumn} title="Add a column">
            +
          </button>
        )}
      </div>

      {state.confirmStartNew && (
        <div className="modal-backdrop" onClick={() => dispatch({ type: 'set-confirm-start-new', open: false })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Start new?</h3>
            <p>
              This wipes <code>session.json</code> and every run folder under{' '}
              <code>agents/mdredd/</code>, except <code>.gitignore</code> and <code>.lock</code>.
            </p>
            <div className="actions">
              <button onClick={() => dispatch({ type: 'set-confirm-start-new', open: false })}>Cancel</button>
              <button className="primary" onClick={onStartNewConfirm}>
                Wipe and start new
              </button>
            </div>
          </div>
        </div>
      )}

      {state.confirmRemoveColumnId && (
        <div
          className="modal-backdrop"
          onClick={() => dispatch({ type: 'set-confirm-remove-column', columnId: null })}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Remove variant column?</h3>
            <p>
              This removes the column from the current session. Any runs for this column stay on
              disk under <code>agents/mdredd/</code> but won't be visible here.
            </p>
            <div className="actions">
              <button
                onClick={() => dispatch({ type: 'set-confirm-remove-column', columnId: null })}
              >
                Cancel
              </button>
              <button className="primary" onClick={onConfirmRemoveColumn}>
                Remove column
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </>
  );
}
