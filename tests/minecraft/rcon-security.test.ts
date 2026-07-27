import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeRconCommand,
  isRconConfigured,
  resolveRconOptions,
  startRconService,
  stopRconService,
  validateRconCommand,
} from '../../src/modules/minecraft/services/rcon-service';

test('RCON configuration fails closed without explicit host, port and password', () => {
  assert.equal(isRconConfigured({}), false);
  assert.throws(
    () => resolveRconOptions({}, {}),
    (error: unknown) => error instanceof Error && error.message === 'RCON_NOT_CONFIGURED'
  );
});

test('RCON configuration accepts explicit environment values', () => {
  const environment = {
    RCON_HOST: 'mc.internal',
    RCON_PORT: '25575',
    RCON_PASSWORD: 'test-secret',
    RCON_TIMEOUT_MS: '7000',
  };

  assert.equal(isRconConfigured(environment), true);
  assert.deepEqual(
    resolveRconOptions({}, environment),
    {
      host: 'mc.internal',
      port: 25575,
      password: 'test-secret',
      timeoutMs: 7000,
    }
  );
});

test('RCON configuration rejects invalid ports and timeouts', () => {
  const base = {
    RCON_HOST: 'mc.internal',
    RCON_PASSWORD: 'test-secret',
  };

  assert.throws(() => resolveRconOptions({}, { ...base, RCON_PORT: '0' }));
  assert.throws(() => resolveRconOptions({}, { ...base, RCON_PORT: '65536' }));
  assert.throws(() => resolveRconOptions({}, {
    ...base,
    RCON_PORT: '25575',
    RCON_TIMEOUT_MS: '60001',
  }));
});

test('RCON runtime accepts only the commands required by the Minecraft module', async (t) => {
  startRconService();
  t.after(async () => stopRconService());

  for (const command of [
    'tps',
    'tellraw @a ["hello"]',
    'give SafePlayer minecraft:diamond 1',
    'erezcraft_chat_flush',
    'erezcraft_verify_code SafePlayer 123456',
  ]) {
    assert.equal(validateRconCommand(command).ok, true, command);
  }

  for (const command of [
    'stop',
    '/stop',
    'restart',
    'op SafePlayer',
    'whitelist off',
    'tellraw @a ["hello"]\nstop',
    '',
  ]) {
    assert.deepEqual(
      validateRconCommand(command),
      { ok: false, error: 'RCON_COMMAND_REJECTED' },
      command,
    );
  }

  assert.deepEqual(
    await executeRconCommand('stop', {}, {
      RCON_HOST: 'mc.internal',
      RCON_PORT: '25575',
      RCON_PASSWORD: 'test-secret',
    }),
    { success: false, error: 'RCON_COMMAND_REJECTED' },
  );
  assert.deepEqual(
    await executeRconCommand('tps', {}, {}),
    { success: false, error: 'RCON_NOT_CONFIGURED' },
  );

  await stopRconService();
  assert.deepEqual(
    await executeRconCommand('tps', {}, {
      RCON_HOST: 'mc.internal',
      RCON_PORT: '25575',
      RCON_PASSWORD: 'test-secret',
    }),
    { success: false, error: 'RCON_SERVICE_STOPPED' },
  );
});
