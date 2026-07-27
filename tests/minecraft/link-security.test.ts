import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateRandom6DigitCode,
  interpretMinecraftLinkVerification,
  isValidMinecraftJavaUsername,
} from '../../src/modules/minecraft/services/link-service';

test('Minecraft Java usernames accept only the official 3-16 character form', () => {
  for (const username of ['abc', 'NaveL_123', 'abcdefghijklmnop']) {
    assert.equal(isValidMinecraftJavaUsername(username), true, username);
  }

  for (const username of [
    'ab',
    'abcdefghijklmnopq',
    '@a',
    'name-with-dash',
    'имя',
    'name with space',
    'name\nop',
  ]) {
    assert.equal(isValidMinecraftJavaUsername(username), false, username);
  }
});

test('link codes always contain exactly six digits', () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(generateRandom6DigitCode(), /^\d{6}$/);
  }
});

test('Discord-side data cannot confirm a link without VERIFIED from RCON', () => {
  assert.deepEqual(
    interpretMinecraftLinkVerification(null),
    { verified: false, reason: 'RCON_UNAVAILABLE' }
  );
  assert.deepEqual(
    interpretMinecraftLinkVerification({ success: true }),
    { verified: false, reason: 'VERIFICATION_FAILED' }
  );
  assert.deepEqual(
    interpretMinecraftLinkVerification({ success: true, response: 'UNKNOWN' }),
    { verified: false, reason: 'VERIFICATION_FAILED' }
  );
  assert.deepEqual(
    interpretMinecraftLinkVerification({ success: true, response: ' VERIFIED ' }),
    { verified: true }
  );
});

test('RCON verification preserves expired and invalid-code outcomes', () => {
  assert.deepEqual(
    interpretMinecraftLinkVerification({ success: true, response: 'EXPIRED' }),
    { verified: false, reason: 'CODE_EXPIRED' }
  );
  assert.deepEqual(
    interpretMinecraftLinkVerification({ success: true, response: 'INVALID_CODE' }),
    { verified: false, reason: 'INVALID_CODE' }
  );
});
