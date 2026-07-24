import test from 'node:test';
import assert from 'node:assert/strict';
import { canReloadFromReloadCommand } from '../../src/modules/general/commands/reload';

test('/reload cannot unload the module that owns its running command', () => {
  assert.equal(canReloadFromReloadCommand('general'), false);
  assert.equal(canReloadFromReloadCommand('teams'), true);
  assert.equal(canReloadFromReloadCommand('regbattle'), true);
});
