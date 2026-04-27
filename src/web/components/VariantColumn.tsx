import { Fragment, useState, type JSX } from 'react';
import type { ColumnConfig } from '@shared/schemas/session.js';
import type { ColumnStatus, Mode } from '@shared/schemas/types.js';
import {
  defaultEffortForModel,
  effortLevelsForModel,
  modelSupportsEffort,
  type Effort,
} from '@shared/constants.js';
import type { JudgeFile } from '@shared/schemas/judge.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { LocalVariant, LocalVariantsResponse } from '@shared/schemas/localVariants.js';
import type { ColumnLiveState } from '../App.js';
import { VariantEditor } from './VariantEditor.js';
import { PromptField } from './PromptField.js';
import { TranscriptView } from './TranscriptView.js';
import {
  formatCost,
  formatElapsed,
  formatTokenCount,
  modelWorkElapsedMs,
  pluralizeToolCalls,
  pluralizeTurns,
} from '../lib/format.js';
import type { TokenUsage } from '@shared/schemas/run.js';
import { JudgeCard } from './JudgeCard.js';
import { Hint } from './Hint.js';

const MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
];

const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const VARIANT_TYPES = [
  { id: 'CLAUDE.md', label: 'CLAUDE.md' },
  { id: 'skill', label: 'Skill' },
  { id: 'agent', label: 'Agent' },
];

const PICKER_NONE = '__none__';
const PICKER_NEW = '__new__';

export function VariantColumn(props: {
  column: ColumnConfig;
  status: ColumnStatus;
  live: ColumnLiveState;
  runBundle: {
    config: RunConfig;
    transcript: TranscriptFile | null;
    judge: JudgeFile | null;
    outputs: OutputFile[];
  } | null;
  isJudging: boolean;
  canRemove: boolean;
  mode: Mode;
  localVariants: LocalVariantsResponse;
  onReloadLocalVariants: () => Promise<void>;
  onPatchColumn: (columnId: string, patch: Partial<ColumnConfig>) => Promise<void>;
  onRun: (columnId: string) => Promise<void>;
  onStop: (columnId: string) => Promise<void>;
  onRemove: (columnId: string) => void | Promise<void>;
}): JSX.Element {
  const { column, status, live, runBundle, isJudging, canRemove, mode, localVariants } = props;

  // Stream-time and judge-time lock its OWN fields. Other columns stay fully
  // editable — runs are independent and write to separate folders.
  const isStreaming = status === 'streaming' || status === 'preparing';
  const isLocked = isStreaming || isJudging;
  const canRun = !isLocked && column.prompt.trim() && column.variantContent.trim();
  const canStop = isStreaming;

  const progressParts = buildProgressParts(status, live, runBundle);

  // Picker state: true when the user is actively creating a new skill/agent.
  const localList = pickLocalList(column.variantType, localVariants);
  const nameMatches = column.skillOrAgentName
    ? localList.some((v) => v.name === column.skillOrAgentName)
    : false;
  const [explicitCreate, setExplicitCreate] = useState(false);

  // Derive "creating new" rather than syncing an effect: when variantType is
  // not skill/agent, the picker isn't shown, so explicitCreate is irrelevant
  // even if it was left true by a previous selection.
  const isPickerType = column.variantType === 'skill' || column.variantType === 'agent';
  const creatingNew =
    isPickerType && (explicitCreate || (Boolean(column.skillOrAgentName) && !nameMatches));

  const onPickFromDropdown = async (value: string): Promise<void> => {
    if (value === PICKER_NONE) {
      setExplicitCreate(false);
      await props.onPatchColumn(column.id, { skillOrAgentName: null, variantContent: '' });
      return;
    }
    if (value === PICKER_NEW) {
      setExplicitCreate(true);
      await props.onPatchColumn(column.id, { skillOrAgentName: '', variantContent: '' });
      return;
    }
    const picked = localList.find((v) => v.name === value);
    if (!picked) return;
    setExplicitCreate(false);
    await props.onPatchColumn(column.id, {
      skillOrAgentName: picked.name,
      variantContent: picked.content,
    });
  };

  const dropdownValue = creatingNew
    ? PICKER_NEW
    : nameMatches
      ? (column.skillOrAgentName as string)
      : PICKER_NONE;

  return (
    <div className="column">
      <div className="column-header">
        <input
          type="text"
          placeholder="Variant name (optional — will be auto-generated)"
          value={column.variantName}
          disabled={isLocked}
          onChange={(e) => void props.onPatchColumn(column.id, { variantName: e.target.value })}
        />
        <Hint content="Model used for the variant run">
          <select
            value={column.model}
            disabled={isLocked}
            onChange={(e) => {
              const nextModel = e.target.value;
              void props.onPatchColumn(column.id, {
                model: nextModel,
                effort: defaultEffortForModel(nextModel),
              });
            }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Hint>
        {modelSupportsEffort(column.model) && (
          <Hint content="Reasoning effort for the variant run">
            <select
              value={column.effort ?? ''}
              disabled={isLocked}
              onChange={(e) => {
                const v = e.target.value;
                void props.onPatchColumn(column.id, {
                  effort: v === '' ? null : (v as Effort),
                });
              }}
            >
              <option value="">Default</option>
              {effortLevelsForModel(column.model).map((x) => (
                <option key={x} value={x}>
                  {EFFORT_LABELS[x]}
                </option>
              ))}
            </select>
          </Hint>
        )}
        <div className="meta-row">
          <Hint content="Variant type — CLAUDE.md, a skill (.claude/skills/), or an agent (.claude/agents/)">
            <select
              value={column.variantType}
              disabled={isLocked}
              onChange={(e) => {
                const next = e.target.value as ColumnConfig['variantType'];
                setExplicitCreate(false);
                void props.onPatchColumn(column.id, {
                  variantType: next,
                  skillOrAgentName: next === 'CLAUDE.md' ? null : column.skillOrAgentName,
                });
              }}
            >
              {VARIANT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Hint>
          {(column.variantType === 'skill' || column.variantType === 'agent') && (
            <>
              <Hint
                content={`Pick a local ${column.variantType} from .claude/ or create a new one`}
              >
                <select
                  value={dropdownValue}
                  disabled={isLocked}
                  onChange={(e) => void onPickFromDropdown(e.target.value)}
                >
                  <option value={PICKER_NONE}>
                    {localList.length === 0 ? `(no local ${column.variantType}s)` : '(pick one…)'}
                  </option>
                  {localList.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name}
                    </option>
                  ))}
                  <option value={PICKER_NEW}>+ Create new {column.variantType}</option>
                </select>
              </Hint>
              {creatingNew && (
                <input
                  type="text"
                  placeholder={`new ${column.variantType} name (letters, numbers, _-)`}
                  value={column.skillOrAgentName ?? ''}
                  disabled={isLocked}
                  onChange={(e) =>
                    void props.onPatchColumn(column.id, {
                      skillOrAgentName: e.target.value || null,
                    })
                  }
                />
              )}
              <Hint content="Rescan .claude/ for local skills/agents">
                <button
                  className="remove-column"
                  onClick={() => void props.onReloadLocalVariants()}
                  style={{ fontSize: 11 }}
                >
                  ↻
                </button>
              </Hint>
            </>
          )}
          <span className={`badge ${status}`}>{status}</span>
          <span style={{ flex: 1 }} />
          {canRemove && !isLocked && (
            <Hint content="Remove column">
              <button className="remove-column" onClick={() => void props.onRemove(column.id)}>
                ×
              </button>
            </Hint>
          )}
        </div>
      </div>

      <VariantEditor
        value={column.variantContent}
        disabled={isLocked}
        onChange={(v) => void props.onPatchColumn(column.id, { variantContent: v })}
      />

      <PromptField
        value={column.prompt}
        disabled={isLocked}
        onChange={(v) => void props.onPatchColumn(column.id, { prompt: v })}
      />

      <div className="run-bar">
        {canStop ? (
          <button className="stop" onClick={() => void props.onStop(column.id)}>
            Stop
          </button>
        ) : (
          <Hint
            content={
              !column.prompt.trim()
                ? 'Fill in a prompt'
                : !column.variantContent.trim()
                  ? 'Paste variant content'
                  : 'Run'
            }
          >
            <button onClick={() => void props.onRun(column.id)} disabled={!canRun}>
              Run
            </button>
          </Hint>
        )}
        <span className="status">
          {progressParts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="status-sep"> · </span>}
              {p.title ? (
                <Hint content={p.title}>
                  <span className="status-part">{p.text}</span>
                </Hint>
              ) : (
                <span className="status-part">{p.text}</span>
              )}
            </Fragment>
          ))}
        </span>
      </div>

      <TranscriptView live={live} runBundle={runBundle} isStreaming={isStreaming} />

      {mode === 'write' && runBundle && runBundle.outputs.length > 0 && (
        <div className="outputs">
          <strong>outputs/</strong>
          <ul style={{ margin: '4px 0 0 0', padding: 0, listStyle: 'none' }}>
            {runBundle.outputs.map((o) => (
              <li key={o.path} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                {o.path} <span style={{ color: 'var(--fg-dim)' }}>({o.bytes} B)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isStreaming &&
        (runBundle?.judge ? (
          <JudgeCard judge={runBundle.judge} />
        ) : isJudging ? (
          <JudgeCard judging />
        ) : null)}
    </div>
  );
}

function pickLocalList(
  variantType: ColumnConfig['variantType'],
  local: LocalVariantsResponse,
): LocalVariant[] {
  if (variantType === 'skill') return local.skills;
  if (variantType === 'agent') return local.agents;
  return [];
}

interface StatusPart {
  text: string;
  title?: string;
}

const TIME_TITLE =
  'Time the model worked to produce the output shown above. Matches the elapsed time on the last turn marker in the transcript.';

function buildProgressParts(
  status: ColumnStatus,
  live: ColumnLiveState,
  runBundle: {
    config: RunConfig;
    transcript: TranscriptFile | null;
  } | null,
): StatusPart[] {
  if (status === 'streaming' || status === 'preparing') {
    const elapsedMs = live.startedAt ? Date.now() - live.startedAt : 0;
    const toolCalls = live.events.filter((e) => e.kind === 'tool-use').length;
    const parts: StatusPart[] = [
      { text: `turn ${live.turnCount}` },
      { text: formatElapsed(elapsedMs), title: TIME_TITLE },
      { text: `${toolCalls}T`, title: pluralizeToolCalls(toolCalls) },
    ];
    if (live.lastTool) parts.push({ text: `last tool: ${live.lastTool}` });
    return parts;
  }
  if (runBundle) {
    const cfg = runBundle.config;
    const workElapsed = modelWorkElapsedMs(runBundle.transcript);
    const toolCalls = runBundle.transcript?.events.filter((e) => e.t === 'toolUse').length ?? 0;
    const parts: StatusPart[] = [
      { text: pluralizeTurns(cfg.turnCount) },
      { text: formatElapsed(workElapsed ?? cfg.wallClockMs), title: TIME_TITLE },
      { text: `${toolCalls}T`, title: pluralizeToolCalls(toolCalls) },
    ];
    const usage = cfg.tokenUsage ?? null;
    if (usage) {
      const input = totalInputTokens(usage);
      const output = usage.outputTokens;
      if (input > 0 || output > 0) {
        parts.push({
          text: `${formatTokenCount(input)} in / ${formatTokenCount(output)} out`,
          title: `Input = new + cache-read + cache-creation (new=${usage.inputTokens}, cache-read=${usage.cacheReadTokens}, cache-creation=${usage.cacheCreationTokens}). Output = generated tokens. Numbers from claude CLI.`,
        });
      }
    }
    if (typeof cfg.costUsd === 'number' && cfg.costUsd > 0) {
      parts.push({
        text: formatCost(cfg.costUsd),
        title: 'USD cost as reported by the claude CLI.',
      });
    }
    if (cfg.truncationReason) {
      parts.push({ text: `truncated (${cfg.truncationReason})` });
    }
    return parts;
  }
  return [];
}

function totalInputTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}
