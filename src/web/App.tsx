import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react';
import type { NormalizedEvent, ServerSseEvent } from '@shared/schemas/events.js';
import type { ColumnConfig, SessionFile } from '@shared/schemas/session.js';
import type { ColumnStatus } from '@shared/schemas/types.js';
import type { JudgeFile } from '@shared/schemas/judge.js';
import { JUDGE_MODEL, JUDGE_MODEL_OPTIONS } from '@shared/constants.js';
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
import { Hint } from './components/Hint.js';

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
  judgingByColumn: Record<string, boolean>;
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
  | { type: 'optimistic-status'; columnId: string; status: ColumnStatus }
  | { type: 'error'; message: string }
  | { type: 'clear-error' }
  | { type: 'set-confirm-start-new'; open: boolean }
  | { type: 'set-confirm-remove-column'; columnId: string | null }
  | { type: 'set-connecting'; value: boolean };

function emptyLive(): ColumnLiveState {
  return { events: [], turnCount: 0, tookMs: 0, startedAt: null, lastTool: null };
}

/**
 * Project a persisted normalized transcript onto the live-event shape so a
 * mid-run page refresh still surfaces the prefix. Mirrors the live SSE
 * reducer's behavior: same `partial` collapsing rule, and drops `message`
 * aggregates because the SSE reducer below does not have a `run.message`
 * branch — even though the server emits those events, the live UI ignores
 * them (they're durability dupes of the partial content; see
 * claudeStream.ts handleAggregateMessage). Issue #10.
 */
function liveStateFromTranscript(events: NormalizedEvent[], startedAtIso: string): ColumnLiveState {
  const startedAtParsed = Date.parse(startedAtIso);
  const startedAt = Number.isFinite(startedAtParsed) ? startedAtParsed : null;
  const out: ColumnLiveState['events'] = [];
  let turnCount = 0;
  let lastTool: string | null = null;
  for (const e of events) {
    switch (e.t) {
      case 'turn': {
        turnCount = e.turn;
        const elapsedMs = startedAt !== null ? Math.max(0, e.ts - startedAt) : 0;
        out.push({ kind: 'turn', turn: e.turn, elapsedMs });
        break;
      }
      case 'partial': {
        const last = out[out.length - 1];
        if (last && last.kind === 'partial' && last.streamKind === e.kind) {
          out[out.length - 1] = { ...last, chunk: last.chunk + e.chunk };
        } else {
          out.push({ kind: 'partial', streamKind: e.kind, chunk: e.chunk });
        }
        break;
      }
      case 'message':
        break;
      case 'toolUse':
        lastTool = e.tool;
        out.push({ kind: 'tool-use', tool: e.tool, argsSummary: e.argsSummary });
        break;
      case 'toolResult':
        out.push({
          kind: 'tool-result',
          tool: e.tool,
          resultSummary: e.resultSummary,
          ...(e.isError !== undefined ? { isError: e.isError } : {}),
        });
        break;
      case 'permissionDenied':
        out.push({ kind: 'permission-denied', tool: e.tool, path: e.path });
        break;
    }
  }
  const tookMs = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
  return { events: out, turnCount, tookMs, startedAt, lastTool };
}

function initialState(): AppState {
  return {
    loaded: false,
    session: null,
    runs: {},
    activeStatuses: {},
    live: {},
    judgingByColumn: {},
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
        const folder = c.currentRunFolder;
        const status = action.payload.activeStatuses[c.id];
        const bundle = folder ? action.payload.runs[folder] : undefined;
        const isActive = status === 'preparing' || status === 'streaming';
        if (bundle?.transcript && isActive) {
          // Reseed live from the persisted ndjson prefix on every snapshot
          // for active runs. Covers both first-load (live empty) and
          // SSE-reconnect-with-stale-live (the 2k in-memory ring may have
          // evicted events during the disconnect; ndjson is the
          // authority). The race against an in-flight buffered write is
          // benign — projected and live carry the same content for events
          // both paths have observed, and any event still buffered when
          // /api/state read will arrive again on the next snapshot. Issue #10.
          live[c.id] = liveStateFromTranscript(
            bundle.transcript.events,
            bundle.transcript.startedAt,
          );
        } else if (!live[c.id]) {
          live[c.id] = emptyLive();
        }
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
    case 'optimistic-status':
      return {
        ...state,
        activeStatuses: { ...state.activeStatuses, [action.columnId]: action.status },
      };
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
      const events: LiveEvent[] =
        last && last.kind === 'partial' && last.streamKind === event.kind
          ? cur.events.slice(0, -1).concat({
              kind: 'partial',
              streamKind: event.kind,
              chunk: last.chunk + event.chunk,
            })
          : [...cur.events, { kind: 'partial', streamKind: event.kind, chunk: event.chunk }];
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
    case 'judge.started': {
      // Only flip the column indicator if the column is still on the run
      // this judge is for. A late event from a stale run leaves the
      // current run's indicator alone.
      const col = state.session?.columns.find((c) => c.id === event.col);
      if (col?.currentRunFolder !== event.runFolder) return state;
      return {
        ...state,
        judgingByColumn: { ...state.judgingByColumn, [event.col]: true },
      };
    }
    case 'judge.updated': {
      const payload = event.payload as JudgeFile;
      const existing = state.runs[payload.runFolder];
      const col = state.session?.columns.find((c) => c.id === event.col);
      const isCurrentRun = col?.currentRunFolder === payload.runFolder;
      const judgingByColumn = isCurrentRun
        ? { ...state.judgingByColumn, [event.col]: false }
        : state.judgingByColumn;
      if (!existing) return { ...state, judgingByColumn };
      return {
        ...state,
        judgingByColumn,
        runs: {
          ...state.runs,
          [payload.runFolder]: { ...existing, judge: payload },
        },
      };
    }
    case 'judge.errored': {
      const existing = state.runs[event.runFolder];
      const col = state.session?.columns.find((c) => c.id === event.col);
      const isCurrentRun = col?.currentRunFolder === event.runFolder;
      const judgingByColumn = isCurrentRun
        ? { ...state.judgingByColumn, [event.col]: false }
        : state.judgingByColumn;
      if (!existing) return { ...state, judgingByColumn };
      const synthetic: JudgeFile = {
        runFolder: event.runFolder,
        createdAt: new Date().toISOString(),
        judgeModel: state.session?.judgeModel ?? JUDGE_MODEL,
        status: 'errored',
        error: event.error,
      };
      return {
        ...state,
        judgingByColumn,
        runs: {
          ...state.runs,
          [event.runFolder]: { ...existing, judge: synthetic },
        },
      };
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
                c.id === event.col
                  ? { ...c, currentRunFolder: event.runFolder ?? c.currentRunFolder }
                  : c,
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
    // Fetch-on-mount: dispatched updates happen after async work, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!state.loaded) return;
    let hadError = false;
    let backstopTimer: number | null = null;
    const es = openSseStream(
      (event) => {
        dispatch({ type: 'sse', event });
        // When a run finishes, pull the fresh bundle so the final turn/time/status
        // appear in the column footer (they come from the run's on-disk config).
        if (event.t === 'run.ended') {
          void loadAll();
        }
      },
      () => {
        dispatch({ type: 'set-connecting', value: false });
        // First successful (re)connect after an error: ring buffer may have
        // evicted events while we were disconnected — backfill from
        // /api/state so the persisted prefix overwrites the stale view
        // (issue #10).
        if (hadError) {
          hadError = false;
          if (backstopTimer !== null) {
            window.clearTimeout(backstopTimer);
            backstopTimer = null;
          }
          void loadAll();
        }
      },
      () => {
        dispatch({ type: 'set-connecting', value: true });
        // Backstop: if the browser's auto-reconnect doesn't re-open within
        // 2s we re-fetch anyway so the user isn't staring at stale state.
        // The onopen handler clears this when reconnect succeeds first.
        if (!hadError) {
          hadError = true;
          backstopTimer = window.setTimeout(() => {
            backstopTimer = null;
            if (hadError) void loadAll();
          }, 2000);
        }
      },
    );
    esRef.current = es;
    return () => {
      if (backstopTimer !== null) window.clearTimeout(backstopTimer);
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
      // Server slug derivation calls Haiku and can take 1-2s before the
      // first SSE arrives. Flip to `preparing` immediately so the button
      // becomes Stop and the variant fields lock — otherwise the user sees
      // nothing happen and may double-click.
      dispatch({ type: 'optimistic-status', columnId, status: 'preparing' });
      try {
        await runColumn(columnId);
      } catch (err) {
        dispatch({ type: 'error', message: (err as Error).message });
        await loadAll();
      }
    },
    [loadAll],
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

  const onChangeJudgeModel = useCallback(async (judgeModel: string) => {
    try {
      const s = await patchSession({ judgeModel });
      dispatch({ type: 'session-patched', payload: s });
    } catch (err) {
      dispatch({ type: 'error', message: (err as Error).message });
    }
  }, []);

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
        <Hint content="MDredd on GitHub">
          <a className="brand" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            MDredd
          </a>
        </Hint>
        <Hint content="Toggle write mode (applies to new runs; current runs keep their original mode)">
          <button className="chip" aria-pressed={session.mode === 'write'} onClick={onToggleMode}>
            Mode: {session.mode === 'write' ? 'Write' : 'Read-only'}
          </button>
        </Hint>
        <div className="judge-chip-wrap">
          <button className="chip" aria-pressed={session.judgeEnabled} onClick={onToggleJudge}>
            Judge {session.judgeEnabled ? 'ON' : 'OFF'}
          </button>
          <div className="judge-popover" role="group" aria-label="Judge settings">
            <div className="judge-popover-row">
              <span className="judge-popover-label">Model</span>
              <select
                value={session.judgeModel}
                onChange={(e) => void onChangeJudgeModel(e.target.value)}
              >
                {JUDGE_MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="judge-popover-hint">
              Applies to new judge runs; existing scores keep their original model.
            </div>
          </div>
        </div>
        <span className="spacer" />
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {session.cwd}
        </span>
        <Hint
          content={
            anyRunning
              ? 'Stop all running columns before starting new'
              : 'Wipe session and all runs'
          }
        >
          <button
            className="chip"
            onClick={() => dispatch({ type: 'set-confirm-start-new', open: true })}
            disabled={anyRunning}
          >
            Start new
          </button>
        </Hint>
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
            runBundle={col.currentRunFolder ? (state.runs[col.currentRunFolder] ?? null) : null}
            isJudging={state.judgingByColumn[col.id] ?? false}
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
          <Hint content="Add a column">
            <button className="add-column" onClick={onAddColumn}>
              +
            </button>
          </Hint>
        )}
      </div>

      {state.confirmStartNew && (
        <div
          className="modal-backdrop"
          onClick={() => dispatch({ type: 'set-confirm-start-new', open: false })}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Start new?</h3>
            <p>
              This wipes <code>session.json</code> and every run folder under{' '}
              <code>~/.mdredd/</code>, except <code>.gitignore</code> and <code>.lock</code>.
            </p>
            <div className="actions">
              <button onClick={() => dispatch({ type: 'set-confirm-start-new', open: false })}>
                Cancel
              </button>
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
              disk under <code>~/.mdredd/</code> but won't be visible here.
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
