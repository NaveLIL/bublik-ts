import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../src/modules/vacation/utils';

test('vacation duration parses complete compound values', () => {
  assert.equal(parseDuration('2w 1d 3h 15m'), 2 * 7 * 24 * 60 + 24 * 60 + 3 * 60 + 15);
  assert.equal(parseDuration('2d+4h'), 2 * 24 * 60 + 4 * 60);
});

test('vacation duration rejects partial or arbitrary text matches', () => {
  assert.equal(parseDuration('forever 3d'), null);
  assert.equal(parseDuration('3d later'), null);
  assert.equal(parseDuration('0d'), null);
});
