import assert from 'node:assert/strict';
import test from 'node:test';
import { canImportBrSource } from '../src/modules/br/policy';

const base = {
  sourceGuildId: 'source',
  targetGuildId: 'target',
  templateGuildId: 'template',
  actorId: 'actor',
  ownerId: 'owner',
  actorCanManageSourceGuild: false,
} as const;

test('BR template and same-guild imports remain available', () => {
  assert.equal(canImportBrSource({ ...base, sourceGuildId: 'template' }), true);
  assert.equal(canImportBrSource({ ...base, sourceGuildId: 'target' }), true);
});

test('arbitrary cross-guild imports fail closed', () => {
  assert.equal(canImportBrSource(base), false);
  assert.equal(canImportBrSource({ ...base, ownerId: null }), false);
});

test('source administrator or configured owner may import cross-guild data', () => {
  assert.equal(canImportBrSource({ ...base, actorCanManageSourceGuild: true }), true);
  assert.equal(canImportBrSource({ ...base, actorId: 'owner' }), true);
});
