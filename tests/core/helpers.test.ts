import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDiscordErrorCode } from '../../src/utils/helpers';

test('Discord absence detection accepts numeric and string API codes only', () => {
  assert.equal(hasDiscordErrorCode({ code: 10007 }, 10007), true);
  assert.equal(hasDiscordErrorCode({ code: '10007' }, 10007), true);
  assert.equal(hasDiscordErrorCode({ code: 500 }, 10007), false);
  assert.equal(hasDiscordErrorCode(new Error('Unknown Member'), 10007), false);
});
