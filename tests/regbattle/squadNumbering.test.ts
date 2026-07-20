import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstFreeSquadNumber,
  legacySquadPlaceholderRepair,
} from '../../src/modules/regbattle/squadNumbering';
import { squadName } from '../../src/modules/regbattle/utils';

test('squad allocation predicts the same first free ordinal used by persistence', () => {
  assert.equal(firstFreeSquadNumber([]), 1);
  assert.equal(firstFreeSquadNumber([1, 2, 3]), 4);
  assert.equal(firstFreeSquadNumber([3, 1]), 2);
  assert.equal(firstFreeSquadNumber([1, 1, 3, 0, -4, Number.NaN]), 2);
});

test('predicted squad number produces the final Discord channel name', () => {
  const number = firstFreeSquadNumber([1, 3]);
  assert.equal(number, 2);
  assert.equal(squadName(number), '⟪ ・ОТРЯД 2・⟫');
});

test('restore repairs only the exact legacy provisional squad name', () => {
  const canonicalName = squadName(1);
  assert.equal(
    legacySquadPlaceholderRepair('⚔️ Создание отряда…', canonicalName),
    canonicalName,
  );
  assert.equal(
    legacySquadPlaceholderRepair('⟪・ОТРЯД 1・⟫', canonicalName),
    null,
    'a commander-renamed channel must be preserved',
  );
});
