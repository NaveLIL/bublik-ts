import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRconConfigured,
  resolveRconOptions,
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
