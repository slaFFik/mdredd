import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/server/runner.js';
import { buildSandbox } from '../src/server/sandbox.js';
import type { RunConfig } from '@shared/schemas/run.js';

const fakeBin = new URL('./fake-claude.mjs', import.meta.url).pathname;

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

console.log('\nAll runner smoke scenarios passed.');
