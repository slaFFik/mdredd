import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { ClaudeStreamParser } from './claudeStream.js';
import { log } from './log.js';
import { atomicWriteJson, ensureDir } from './fsUtil.js';
import type { NormalizedEvent } from '@shared/schemas/events.js';
import type { RunConfig, TranscriptFile, OutputFile } from '@shared/schemas/run.js';
import type { RunStatus, TruncationReason } from '@shared/schemas/types.js';
import {
  DEFAULT_TURN_CAP,
  DEFAULT_WALLCLOCK_CAP_MS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from '@shared/constants.js';
import type { Mode } from '@shared/schemas/types.js';

export interface RunnerInput {
  claudeBin: string;
  projectDir: string;       // child claude's cwd = <run>/project
  runDir: string;           // <run>/ — where stream.jsonl, stderr.log, etc. live
  outputsDir: string;       // <run>/outputs — scanned after run
  prompt: string;
  model: string;
  mode: Mode;
  allowedTools?: string[];  // defaults based on mode
  caps?: { turns?: number; wallClockMs?: number };
  env?: NodeJS.ProcessEnv;
  initialConfig: RunConfig; // mutated in place as run progresses
}

export interface RunnerEvents {
  started: (config: RunConfig) => void;
  normalized: (event: NormalizedEvent) => void;
  statusChanged: (status: RunStatus) => void;
  ended: (config: RunConfig) => void;
  outputs: (files: OutputFile[]) => void;
}

const STDIN_BLOCK_KILL_MS = 15_000;
const SIGKILL_GRACE_MS = 2_000;

export class Runner extends EventEmitter {
  private child: ChildProcess | null = null;
  private parser = new ClaudeStreamParser();
  private streamLog: WriteStream | null = null;
  private stderrLog: WriteStream | null = null;
  private parseErrorsLog: WriteStream | null = null;
  private transcriptLog: WriteStream | null = null;
  private startedAt = 0;
  private turnCap: number;
  private wallClockCap: number;
  private wallClockTimer: NodeJS.Timeout | null = null;
  private stdinKillTimer: NodeJS.Timeout | null = null;
  private truncating = false;
  private truncationReason: TruncationReason = null;
  private cancelled = false;
  private ended = false;
  private endedPromise: Promise<RunConfig>;
  private endedResolve!: (cfg: RunConfig) => void;
  private events: NormalizedEvent[] = [];
  private readonly input: RunnerInput;

  constructor(input: RunnerInput) {
    super();
    this.input = input;
    this.turnCap = input.caps?.turns ?? DEFAULT_TURN_CAP;
    this.wallClockCap = input.caps?.wallClockMs ?? DEFAULT_WALLCLOCK_CAP_MS;
    this.endedPromise = new Promise<RunConfig>((resolve) => {
      this.endedResolve = resolve;
    });
  }

  override on<E extends keyof RunnerEvents>(event: E, listener: RunnerEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof RunnerEvents>(
    event: E,
    ...args: Parameters<RunnerEvents[E]>
  ): boolean {
    return super.emit(event, ...(args as unknown[]));
  }

  wait(): Promise<RunConfig> {
    return this.endedPromise;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.input.initialConfig.startedAt = new Date(this.startedAt).toISOString();
    this.input.initialConfig.status = 'streaming';
    this.input.initialConfig.caps = {
      turns: this.turnCap,
      wallClockMs: this.wallClockCap,
    };
    this.input.initialConfig.toolAllowlist =
      this.input.allowedTools ?? (this.input.mode === 'write' ? WRITE_TOOLS : READ_ONLY_TOOLS);

    await ensureDir(this.input.runDir);
    this.streamLog = createWriteStream(join(this.input.runDir, 'stream.jsonl'), { flags: 'a' });
    this.stderrLog = createWriteStream(join(this.input.runDir, 'stderr.log'), { flags: 'a' });
    this.parseErrorsLog = createWriteStream(
      join(this.input.runDir, 'parse-errors.log'),
      { flags: 'a' },
    );
    // Append-only normalized event log. Persisted incrementally so a browser
    // refresh or harness crash mid-run can replay the prefix from disk —
    // transcript.json is only written at finalize() (issue #10).
    this.transcriptLog = createWriteStream(
      join(this.input.runDir, 'transcript.ndjson'),
      { flags: 'a' },
    );

    await this.persistConfig();

    const args = this.buildArgs();
    log.info('runner.spawn', {
      bin: this.input.claudeBin,
      cwd: this.input.projectDir,
      model: this.input.model,
      mode: this.input.mode,
    });

    const child = spawn(this.input.claudeBin, args, {
      cwd: this.input.projectDir,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    // Close stdin proactively — kill if process somehow blocks waiting for stdin.
    child.stdin?.end();
    this.stdinKillTimer = setTimeout(() => {
      if (this.ended) return;
      if (!this.child) return;
      const info = { pid: this.child.pid };
      log.warn('runner.stdin-blocked-killing', info);
      this.trip('errored', 'stdin blocked (interactive auth?)');
    }, STDIN_BLOCK_KILL_MS);

    this.parser.on('rawStreamLine', (line) => {
      this.streamLog?.write(line + '\n');
    });
    this.parser.on('parseError', (raw, err) => {
      this.parseErrorsLog?.write(`${new Date().toISOString()} ${err.message} :: ${raw}\n`);
    });
    this.parser.on('normalized', (e) => {
      this.events.push(e);
      // Persist before emitting: if the harness dies between write and emit,
      // the on-disk log is the source of truth for /api/state replay.
      this.transcriptLog?.write(JSON.stringify(e) + '\n');
      this.emit('normalized', e);
    });
    this.parser.on('turn', (n) => {
      this.input.initialConfig.turnCount = n;
      if (n >= this.turnCap) {
        this.trip('truncated', 'turns', 'turns');
      }
    });
    this.parser.on('novelType', (t) => {
      log.warn('runner.novel-event-type', { type: t });
    });
    this.parser.on('systemInit', (raw) => {
      this.handleSystemInit(raw);
    });
    this.parser.on('result', (payload) => {
      // CLI's final event carries authoritative usage + cost totals.
      const usage = (payload as Record<string, unknown>).usage as Record<string, unknown> | undefined;
      if (usage) {
        this.input.initialConfig.tokenUsage = {
          inputTokens: Number(usage.input_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
          cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
        };
      }
      const cost = (payload as Record<string, unknown>).total_cost_usd;
      if (typeof cost === 'number') {
        this.input.initialConfig.costUsd = cost;
      }
    });

    this.wallClockTimer = setTimeout(() => {
      this.trip('truncated', 'wallclock', 'wallclock');
    }, this.wallClockCap);

    if (child.stdout) {
      // First byte indicates the child is alive and responding; cancel the stdin-block kill.
      child.stdout.once('data', () => {
        if (this.stdinKillTimer) {
          clearTimeout(this.stdinKillTimer);
          this.stdinKillTimer = null;
        }
      });
      this.parser.consume(child.stdout).catch((err) => {
        log.error('runner.parser-error', { error: (err as Error).message });
      });
    }

    child.stderr?.on('data', (buf: Buffer) => {
      this.stderrLog?.write(buf);
    });

    child.on('error', (err) => {
      log.error('runner.child-error', { error: err.message });
      this.finalize('errored', null, null, err.message);
    });

    child.on('exit', (code, signal) => {
      log.info('runner.child-exit', { code, signal });
      if (this.ended) return;
      if (this.cancelled) {
        this.finalize('cancelled', code, signal, null);
      } else if (this.truncating) {
        this.finalize('truncated', code, signal, null);
      } else if (code === 0) {
        this.finalize('completed', code, signal, null);
      } else {
        this.finalize('errored', code, signal, `exit code ${code}`);
      }
    });

    this.emit('started', this.input.initialConfig);
  }

  async stop(): Promise<void> {
    if (this.ended) return;
    if (!this.child) return;
    this.cancelled = true;
    await this.terminateChild();
  }

  private trip(status: 'errored' | 'truncated', reason: string, truncationReason?: 'turns' | 'wallclock'): void {
    if (this.ended) return;
    if (status === 'truncated') {
      this.truncating = true;
      this.truncationReason = truncationReason ?? null;
    }
    log.warn('runner.trip', { status, reason });
    this.terminateChild().catch((err) => {
      log.error('runner.terminate-error', { error: (err as Error).message });
    });
  }

  private async terminateChild(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill('SIGTERM');
    } catch {
      /* process may already be dead */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* */
        }
        resolve();
      }, SIGKILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private finalize(status: RunStatus, exitCode: number | null, signal: NodeJS.Signals | null, errorMessage: string | null): void {
    if (this.ended) return;
    this.ended = true;
    if (this.wallClockTimer) clearTimeout(this.wallClockTimer);
    if (this.stdinKillTimer) clearTimeout(this.stdinKillTimer);
    const endedAt = Date.now();
    const cfg = this.input.initialConfig;
    cfg.status = status;
    cfg.endedAt = new Date(endedAt).toISOString();
    cfg.wallClockMs = endedAt - this.startedAt;
    cfg.exitCode = exitCode;
    cfg.signal = signal;
    cfg.errorMessage = errorMessage;
    cfg.truncationReason = this.truncationReason;

    this.emit('statusChanged', status);

    Promise.resolve()
      .then(async () => {
        this.streamLog?.end();
        this.stderrLog?.end();
        this.parseErrorsLog?.end();
        this.transcriptLog?.end();

        const transcript: TranscriptFile = {
          runFolder: cfg.runFolder,
          events: this.events,
          status,
          startedAt: cfg.startedAt,
          endedAt: cfg.endedAt,
          turnCount: cfg.turnCount,
          wallClockMs: cfg.wallClockMs,
          truncationReason: cfg.truncationReason,
        };
        await atomicWriteJson(join(this.input.runDir, 'transcript.json'), transcript);
        await this.persistConfig();

        const outputs = await this.listOutputs();
        this.emit('outputs', outputs);

        this.emit('ended', cfg);
        this.endedResolve(cfg);
      })
      .catch((err) => {
        log.error('runner.finalize-error', { error: (err as Error).message });
        this.emit('ended', cfg);
        this.endedResolve(cfg);
      });
  }

  private async persistConfig(): Promise<void> {
    await atomicWriteJson(join(this.input.runDir, 'config.json'), this.input.initialConfig);
  }

  /**
   * Persist the child's `system init` payload as `init.json` for audit, and warn
   * if it shows context leakage from the host project.
   *
   * Leakage signal: the child reports `memory_paths.auto` (the per-project
   * auto-memory directory it loaded). With the sandbox `.git/` planted, this
   * path's encoded form should contain the run folder name. If it doesn't,
   * Claude Code resolved the project root somewhere outside the sandbox —
   * meaning host-project auto-memory and git state are bleeding in.
   */
  private handleSystemInit(raw: Record<string, unknown>): void {
    writeFile(
      join(this.input.runDir, 'init.json'),
      JSON.stringify(raw, null, 2),
      'utf8',
    ).catch((err) => {
      log.warn('runner.init-write-failed', { error: (err as Error).message });
    });

    const memoryPaths = raw.memory_paths as Record<string, unknown> | undefined;
    const auto = memoryPaths?.auto;
    if (typeof auto !== 'string' || auto.length === 0) return;
    const runFolderName = basename(this.input.runDir);
    if (!auto.includes(runFolderName)) {
      log.warn('runner.context-leak.auto-memory', {
        runFolder: runFolderName,
        autoMemoryPath: auto,
        hint: 'child resolved a project root outside the sandbox; host auto-memory is being injected into context',
      });
    }
  }

  private buildArgs(): string[] {
    const tools = this.input.allowedTools ?? (this.input.mode === 'write' ? WRITE_TOOLS : READ_ONLY_TOOLS);
    const toolsStr = tools.join(',');
    const args = [
      '-p',
      this.input.prompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      this.input.model,
      '--tools',
      toolsStr,
      '--allowedTools',
      toolsStr,
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--disable-slash-commands',
    ];
    return args;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...(this.input.env ?? process.env) };
    // Strip NODE_OPTIONS: don't let our harness inject debuggers/loaders into the child.
    delete base.NODE_OPTIONS;
    // Strip git-discovery env vars. If any of these are set in the parent shell
    // (e.g. user invoked mdredd from inside a git operation, or has GIT_DIR
    // exported), they would override the planted sandbox .git/ and redirect
    // the child to the host project's git state.
    delete base.GIT_DIR;
    delete base.GIT_WORK_TREE;
    delete base.GIT_INDEX_FILE;
    delete base.GIT_COMMON_DIR;
    delete base.GIT_CEILING_DIRECTORIES;
    // Strip Claude Code project-id hints that could override the cwd-based
    // project resolution and re-anchor auto-memory to the host project.
    delete base.CLAUDE_PROJECT_DIR;
    delete base.CLAUDE_PROJECT_NAME;
    // Keep HOME / CLAUDE_CONFIG_DIR as-is so the child can read the user's auth.
    return base;
  }

  private async listOutputs(): Promise<OutputFile[]> {
    const out: OutputFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          try {
            const s = await stat(full);
            const rel = relative(this.input.outputsDir, full);
            out.push({ path: rel, bytes: s.size });
          } catch {
            /* ignore */
          }
        }
      }
    };
    await walk(this.input.outputsDir);
    return out;
  }
}

