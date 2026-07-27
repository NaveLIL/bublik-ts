import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuildMember } from 'discord.js';
import type { MemberRoleLock } from '../src/core/MemberRoleLock';
import { parseDuration, restoreRoles } from '../src/modules/vacation/utils';

test('vacation duration parses complete compound values', () => {
  assert.equal(parseDuration('2w 1d 3h 15m'), 2 * 7 * 24 * 60 + 24 * 60 + 3 * 60 + 15);
  assert.equal(parseDuration('2d+4h'), 2 * 24 * 60 + 4 * 60);
});

test('vacation duration rejects partial or arbitrary text matches', () => {
  assert.equal(parseDuration('forever 3d'), null);
  assert.equal(parseDuration('3d later'), null);
  assert.equal(parseDuration('0d'), null);
});

test('restore removes an unproven current ping before the vacation marker', async () => {
  const roleIds = new Set(['vacation', 'ping']);
  const removals: string[] = [];
  const member = {
    id: 'member',
    roles: {
      cache: { has: (roleId: string) => roleIds.has(roleId) },
      remove: async (roleId: string) => {
        removals.push(roleId);
        roleIds.delete(roleId);
      },
    },
  } as unknown as GuildMember;
  const lock = { assertOwned: async () => undefined } as unknown as MemberRoleLock;

  await restoreRoles(member, [], 'vacation', lock, 'ping');

  assert.deepEqual(removals, ['ping', 'vacation']);
  assert.deepEqual([...roleIds], []);
});
