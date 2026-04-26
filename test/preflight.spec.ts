import { authSmokeTest, PreflightError } from '../src/server/preflight.js';

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

async function expectPreflightError(
  fn: () => Promise<void>,
  expectedCode: string,
  hintMustInclude: string,
): Promise<PreflightError> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof PreflightError)) {
      throw new Error(
        `expected PreflightError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (err.code !== expectedCode) {
      throw new Error(`expected code ${expectedCode}, got ${err.code} — ${err.message}`, {
        cause: err,
      });
    }
    if (!err.hint || !err.hint.includes(hintMustInclude)) {
      throw new Error(`expected hint to include "${hintMustInclude}", got: ${err.hint}`, {
        cause: err,
      });
    }
    return err;
  }
  throw new Error('expected the call to throw, but it returned');
}

await scenario('authSmokeTest: passes when fake-claude exits 0', async () => {
  const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  try {
    await authSmokeTest(fakeBin);
  } finally {
    if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
  }
});

await scenario(
  'authSmokeTest: surfaces `claude login` hint when fake-claude is unauthenticated',
  async () => {
    const prevScenario = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = 'auth-error';
    try {
      const err = await expectPreflightError(
        () => authSmokeTest(fakeBin),
        'claude-auth-failed',
        'claude login',
      );
      if (!err.message.includes('Authentication required')) {
        throw new Error(`expected stderr tail in message, got: ${err.message}`);
      }
    } finally {
      if (prevScenario === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = prevScenario;
    }
  },
);

await scenario('authSmokeTest: spawn-error path when binary is missing', async () => {
  await expectPreflightError(
    () => authSmokeTest('/definitely/not/a/real/claude-binary-xyz'),
    'claude-auth-spawn-failed',
    'PATH',
  );
});

console.log('\nAll preflight smoke scenarios passed.');
