import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Runner } from '../src/server/runner.js';
import { RunManager } from '../src/server/runManager.js';
import { SessionStore } from '../src/server/session.js';
import { buildSandbox } from '../src/server/sandbox.js';
import type { RunConfig } from '@shared/schemas/run.js';

const fakeBin = new URL('./fake-claude.mjs', import.meta.url).pathname;

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // Cast through unknown to satisfy the overloaded write signature.
  const tap = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    lines.push(text);
    return (orig as unknown as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as unknown as typeof process.stderr.write;
  process.stderr.write = tap;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`• ${name} … `);
  try {
    await run();
    process.stdout.write('PASS\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(err);
    process.exit(1);
  }
}

async function withSandbox(
  scenarioName: string,
  runFn: (args: {
    runDir: string;
    projectDir: string;
    outputsDir: string;
    initialConfig: RunConfig;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'mdredd-smoke-cwd-'));
  const storageRoot = join(cwd, 'agents', 'mdredd');
  const runFolder = `run-${Date.now()}`;
  const sandbox = await buildSandbox({
    cwd,
    storageRoot,
    runFolder,
    variantType: 'CLAUDE.md',
    skillOrAgentName: null,
    variantContent: `# ${scenarioName}\nBe concise.\n`,
    mode: 'read-only',
  });
  const initialConfig: RunConfig = {
    runFolder,
    columnId: 'col-1',
    variantName: scenarioName,
    variantType: 'CLAUDE.md',
    skillOrAgentName: null,
    variantContentSha256: '',
    promptSha256: '',
    prompt: 'test prompt',
    model: 'haiku',
    mode: 'read-only',
    status: 'preparing',
    startedAt: new Date().toISOString(),
    endedAt: null,
    turnCount: 0,
    wallClockMs: 0,
    truncationReason: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    toolAllowlist: [],
    caps: { turns: 50, wallClockMs: 30_000 },
  };

  try {
    await runFn({ ...sandbox, initialConfig });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

await scenario('happy path: single turn completes', async () => {
  await withSandbox('happy', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'hello from smoke test',
      model: 'haiku',
      mode: 'read-only',
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'happy' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    if (final.turnCount !== 1) throw new Error(`expected 1 turn, got ${final.turnCount}`);
    const transcript = JSON.parse(await readFile(join(runDir, 'transcript.json'), 'utf8'));
    if (transcript.status !== 'completed') throw new Error('transcript status mismatch');
    if (!transcript.events.find((e: { t: string }) => e.t === 'turn')) {
      throw new Error('no turn event in transcript');
    }
  });
});

await scenario('turn cap: many-turns scenario trips at cap', async () => {
  await withSandbox('turn-cap', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    initialConfig.caps.turns = 3;
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      caps: { turns: 3 },
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'many-turns', FAKE_CLAUDE_TURNS: '10' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'truncated') throw new Error(`expected truncated, got ${final.status}`);
    if (final.truncationReason !== 'turns') throw new Error(`expected turns reason, got ${final.truncationReason}`);
  });
});

await scenario('wallclock cap: long-running scenario trips', async () => {
  await withSandbox('wallclock', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      caps: { turns: 100, wallClockMs: 800 },
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'long', FAKE_CLAUDE_DELAY_MS: '3000' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'truncated') throw new Error(`expected truncated, got ${final.status}`);
    if (final.truncationReason !== 'wallclock') throw new Error(`expected wallclock, got ${final.truncationReason}`);
  });
});

await scenario('cancel: stop() marks cancelled', async () => {
  await withSandbox('cancel', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'long', FAKE_CLAUDE_DELAY_MS: '3000' },
    });
    await runner.start();
    setTimeout(() => runner.stop(), 100);
    const final = await runner.wait();
    if (final.status !== 'cancelled') throw new Error(`expected cancelled, got ${final.status}`);
  });
});

await scenario('malformed lines: logged and run continues', async () => {
  await withSandbox('malformed', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'malformed' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    const errors = await readFile(join(runDir, 'parse-errors.log'), 'utf8').catch(() => '');
    if (!errors.includes('this is not valid json')) {
      throw new Error('parse-errors.log should contain the bad line');
    }
  });
});

await scenario('multi-turn: completes with exact turn count', async () => {
  await withSandbox('multi-turn', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      caps: { turns: 100, wallClockMs: 30_000 },
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'many-turns', FAKE_CLAUDE_TURNS: '5' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    if (final.turnCount !== 5) throw new Error(`expected 5 turns, got ${final.turnCount}`);
    const transcript = JSON.parse(await readFile(join(runDir, 'transcript.json'), 'utf8'));
    const turns = transcript.events.filter((e: { t: string }) => e.t === 'turn');
    if (turns.length !== 5) {
      throw new Error(`expected 5 turn events in transcript, got ${turns.length}`);
    }
    const sequence = turns.map((e: { turn: number }) => e.turn);
    if (sequence.join(',') !== '1,2,3,4,5') {
      throw new Error(`expected sequential 1..5, got ${sequence.join(',')}`);
    }
  });
});

await scenario('tool-use does not count as a turn', async () => {
  await withSandbox('tool-use', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      caps: { turns: 100, wallClockMs: 30_000 },
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'tool-use' },
    });
    await runner.start();
    const final = await runner.wait();
    // The tool-use scenario emits: one assistant msg with stop_reason=tool_use (not a turn),
    // a tool result, then one final assistant msg with stop_reason=end_turn (a turn).
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    if (final.turnCount !== 1) throw new Error(`expected 1 turn, got ${final.turnCount}`);
  });
});

await scenario('parallel tool calls: pairing by tool_use_id', async () => {
  await withSandbox('parallel-tools', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      caps: { turns: 100, wallClockMs: 30_000 },
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'parallel-tool-use' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    const transcript = JSON.parse(await readFile(join(runDir, 'transcript.json'), 'utf8')) as {
      events: Array<{ t: string; id?: string; tool?: string; resultSummary?: string }>;
    };
    const uses = transcript.events.filter((e) => e.t === 'toolUse');
    const results = transcript.events.filter((e) => e.t === 'toolResult');
    if (uses.length !== 2) throw new Error(`expected 2 toolUse events, got ${uses.length}`);
    if (results.length !== 2) throw new Error(`expected 2 toolResult events, got ${results.length}`);
    if (uses[0]!.id !== 'tu-0' || uses[1]!.id !== 'tu-1') {
      throw new Error(`toolUse ids: ${uses.map((u) => u.id).join(',')}`);
    }
    // Results arrive in reverse order (tu-1 before tu-0). Each must be paired
    // back to its tool_use by id, NOT to the most recent tool_use start.
    if (results[0]!.id !== 'tu-1' || results[0]!.tool !== 'Grep') {
      throw new Error(`first result wrongly attributed: id=${results[0]!.id} tool=${results[0]!.tool}`);
    }
    if (results[1]!.id !== 'tu-0' || results[1]!.tool !== 'Glob') {
      throw new Error(`second result wrongly attributed: id=${results[1]!.id} tool=${results[1]!.tool}`);
    }
    // Bodies match the right tool, not swapped.
    if (!results[0]!.resultSummary?.includes('grep result')) {
      throw new Error(`Grep result body mismatched: ${results[0]!.resultSummary}`);
    }
    if (!results[1]!.resultSummary?.includes('glob result')) {
      throw new Error(`Glob result body mismatched: ${results[1]!.resultSummary}`);
    }
  });
});

await scenario('parallel runs: stats are isolated per run', async () => {
  const cwds = await Promise.all([
    mkdtemp(join(tmpdir(), 'mdredd-smoke-cwd-')),
    mkdtemp(join(tmpdir(), 'mdredd-smoke-cwd-')),
  ]);
  try {
    const makeInput = (cwd: string, name: string): Promise<{
      runDir: string;
      projectDir: string;
      outputsDir: string;
      initialConfig: RunConfig;
    }> =>
      (async () => {
        const storageRoot = join(cwd, 'agents', 'mdredd');
        const runFolder = `run-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sandbox = await buildSandbox({
          cwd,
          storageRoot,
          runFolder,
          variantType: 'CLAUDE.md',
          skillOrAgentName: null,
          variantContent: `# ${name}\n`,
          mode: 'read-only',
        });
        const initialConfig: RunConfig = {
          runFolder,
          columnId: `col-${name}`,
          variantName: name,
          variantType: 'CLAUDE.md',
          skillOrAgentName: null,
          variantContentSha256: '',
          promptSha256: '',
          prompt: 'test',
          model: 'haiku',
          mode: 'read-only',
          status: 'preparing',
          startedAt: new Date().toISOString(),
          endedAt: null,
          turnCount: 0,
          wallClockMs: 0,
          truncationReason: null,
          exitCode: null,
          signal: null,
          errorMessage: null,
          toolAllowlist: [],
          caps: { turns: 50, wallClockMs: 30_000 },
        };
        return { ...sandbox, initialConfig };
      })();

    const inputA = await makeInput(cwds[0]!, 'A');
    const inputB = await makeInput(cwds[1]!, 'B');

    const runnerA = new Runner({
      claudeBin: fakeBin,
      projectDir: inputA.projectDir,
      runDir: inputA.runDir,
      outputsDir: inputA.outputsDir,
      prompt: 'A',
      model: 'haiku',
      mode: 'read-only',
      initialConfig: inputA.initialConfig,
      env: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: 'many-turns',
        FAKE_CLAUDE_TURNS: '2',
        FAKE_CLAUDE_PER_TURN_DELAY_MS: '50',
      },
    });
    const runnerB = new Runner({
      claudeBin: fakeBin,
      projectDir: inputB.projectDir,
      runDir: inputB.runDir,
      outputsDir: inputB.outputsDir,
      prompt: 'B',
      model: 'haiku',
      mode: 'read-only',
      initialConfig: inputB.initialConfig,
      env: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: 'many-turns',
        FAKE_CLAUDE_TURNS: '7',
        FAKE_CLAUDE_PER_TURN_DELAY_MS: '50',
      },
    });

    // Start both in parallel.
    await Promise.all([runnerA.start(), runnerB.start()]);
    const [finalA, finalB] = await Promise.all([runnerA.wait(), runnerB.wait()]);

    if (finalA.turnCount !== 2) {
      throw new Error(`A expected 2 turns, got ${finalA.turnCount}`);
    }
    if (finalB.turnCount !== 7) {
      throw new Error(`B expected 7 turns, got ${finalB.turnCount}`);
    }
    if (finalA.runFolder === finalB.runFolder) {
      throw new Error('A and B share the same runFolder');
    }
    // B runs more turns with the same per-turn delay → should take noticeably longer.
    if (finalB.wallClockMs <= finalA.wallClockMs) {
      throw new Error(
        `B should take longer than A (A=${finalA.wallClockMs}ms, B=${finalB.wallClockMs}ms)`,
      );
    }
    // On-disk config/transcript stats must match the runner's final config exactly.
    const cfgA = JSON.parse(await readFile(join(inputA.runDir, 'config.json'), 'utf8'));
    const cfgB = JSON.parse(await readFile(join(inputB.runDir, 'config.json'), 'utf8'));
    if (cfgA.turnCount !== 2 || cfgB.turnCount !== 7) {
      throw new Error(`on-disk config: A.turnCount=${cfgA.turnCount}, B.turnCount=${cfgB.turnCount}`);
    }
    if (cfgA.wallClockMs === cfgB.wallClockMs) {
      throw new Error('on-disk wallClockMs identical — suspicious');
    }
    const txA = JSON.parse(await readFile(join(inputA.runDir, 'transcript.json'), 'utf8'));
    const txB = JSON.parse(await readFile(join(inputB.runDir, 'transcript.json'), 'utf8'));
    const turnsA = txA.events.filter((e: { t: string }) => e.t === 'turn').length;
    const turnsB = txB.events.filter((e: { t: string }) => e.t === 'turn').length;
    if (turnsA !== 2 || turnsB !== 7) {
      throw new Error(`transcript turns: A=${turnsA}, B=${turnsB}`);
    }
  } finally {
    await Promise.all(cwds.map((d) => rm(d, { recursive: true, force: true })));
  }
});

await scenario('auth-error: non-zero exit → errored', async () => {
  await withSandbox('auth-error', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'go',
      model: 'haiku',
      mode: 'read-only',
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'auth-error' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'errored') throw new Error(`expected errored, got ${final.status}`);
    const stderr = await readFile(join(runDir, 'stderr.log'), 'utf8').catch(() => '');
    if (!stderr.includes('Authentication required')) {
      throw new Error('stderr.log should contain the auth error');
    }
  });
});

await scenario('init.json: persisted with the system init payload', async () => {
  await withSandbox('init-artifact', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const runner = new Runner({
      claudeBin: fakeBin,
      projectDir,
      runDir,
      outputsDir,
      prompt: 'hello',
      model: 'haiku',
      mode: 'read-only',
      initialConfig,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: 'happy' },
    });
    await runner.start();
    const final = await runner.wait();
    if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
    const initRaw = await readFile(join(runDir, 'init.json'), 'utf8');
    const init = JSON.parse(initRaw);
    if (init.type !== 'system' || init.subtype !== 'init') {
      throw new Error(`init.json missing system/init markers: ${initRaw.slice(0, 120)}`);
    }
    if (typeof init.session_id !== 'string' || !init.session_id.startsWith('fake-')) {
      throw new Error(`init.json session_id unexpected: ${init.session_id}`);
    }
  });
});

await scenario('init context leak: warns when auto-memory falls outside the run dir', async () => {
  await withSandbox('init-leak', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const cap = captureStderr();
    try {
      const runner = new Runner({
        claudeBin: fakeBin,
        projectDir,
        runDir,
        outputsDir,
        prompt: 'hello',
        model: 'haiku',
        mode: 'read-only',
        initialConfig,
        env: {
          ...process.env,
          FAKE_CLAUDE_SCENARIO: 'happy',
          // Path deliberately omits the run folder name → mimics the host-project
          // auto-memory dir Claude Code would load if it walked up to a real .git.
          FAKE_CLAUDE_AUTO_MEMORY: '/tmp/some-other-project/memory/',
        },
      });
      await runner.start();
      const final = await runner.wait();
      if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
      const captured = cap.lines.join('');
      if (!captured.includes('runner.context-leak.auto-memory')) {
        throw new Error(`expected leakage warn, captured stderr was:\n${captured}`);
      }
    } finally {
      cap.restore();
    }
  });
});

await scenario('init context safe: no warn when auto-memory is inside the run dir', async () => {
  await withSandbox('init-safe', async ({ runDir, projectDir, outputsDir, initialConfig }) => {
    const cap = captureStderr();
    try {
      const safeAuto = `/Users/test/.claude/projects/-${basename(runDir)}-project/memory/`;
      const runner = new Runner({
        claudeBin: fakeBin,
        projectDir,
        runDir,
        outputsDir,
        prompt: 'hello',
        model: 'haiku',
        mode: 'read-only',
        initialConfig,
        env: {
          ...process.env,
          FAKE_CLAUDE_SCENARIO: 'happy',
          FAKE_CLAUDE_AUTO_MEMORY: safeAuto,
        },
      });
      await runner.start();
      const final = await runner.wait();
      if (final.status !== 'completed') throw new Error(`expected completed, got ${final.status}`);
      const captured = cap.lines.join('');
      if (captured.includes('runner.context-leak.auto-memory')) {
        throw new Error(`unexpected leakage warn for safe auto-memory:\n${captured}`);
      }
    } finally {
      cap.restore();
    }
  });
});

await scenario('runManager.stopAll: terminates active runners and persists cancelled transcripts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mdredd-stopall-'));
  const storageRoot = join(cwd, 'agents', 'mdredd');
  const savedScenario = process.env.FAKE_CLAUDE_SCENARIO;
  const savedDelay = process.env.FAKE_CLAUDE_DELAY_MS;
  // Long-running fake; SIGTERM during the initial sleep cancels mid-stream so
  // the runner has to follow the cancelled finalize path (issue #6 main risk).
  process.env.FAKE_CLAUDE_SCENARIO = 'long';
  process.env.FAKE_CLAUDE_DELAY_MS = '5000';
  try {
    const session = await SessionStore.load(storageRoot, cwd);
    await session.mutate((s) => {
      for (const [i, col] of s.columns.entries()) {
        col.variantName = `stopall-var-${i}`; // explicit name skips the haiku slug spawn
        col.variantContent = `# variant ${i}\n`;
        col.prompt = `do thing ${i}`;
      }
    });
    const runManager = new RunManager({ claudeBin: fakeBin, cwd, storageRoot, session });
    await runManager.init();

    const cfg1 = await runManager.startColumn('col-1');
    const cfg2 = await runManager.startColumn('col-2');
    if (runManager.activeCount() !== 2) {
      throw new Error(`expected 2 active runners, got ${runManager.activeCount()}`);
    }

    const result = await runManager.stopAll(5_000);
    if (result.timedOut) throw new Error('stopAll should not have timed out');
    if (result.stopped !== 2) throw new Error(`expected stopped=2, got ${result.stopped}`);
    if (runManager.activeCount() !== 0) {
      throw new Error(`expected 0 active after stopAll, got ${runManager.activeCount()}`);
    }

    for (const cfg of [cfg1, cfg2]) {
      const txRaw = await readFile(join(storageRoot, cfg.runFolder, 'transcript.json'), 'utf8');
      const tx = JSON.parse(txRaw) as { status: string };
      if (tx.status !== 'cancelled') {
        throw new Error(`transcript ${cfg.runFolder}: expected cancelled, got ${tx.status}`);
      }
    }

    // Idempotent: a second stopAll on a drained manager is a no-op.
    const second = await runManager.stopAll(1_000);
    if (second.stopped !== 0 || second.timedOut) {
      throw new Error(`second stopAll mismatch: ${JSON.stringify(second)}`);
    }
  } finally {
    if (savedScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = savedScenario;
    if (savedDelay === undefined) delete process.env.FAKE_CLAUDE_DELAY_MS;
    else process.env.FAKE_CLAUDE_DELAY_MS = savedDelay;
    await rm(cwd, { recursive: true, force: true });
  }
});

console.log('\nAll runner smoke scenarios passed.');
