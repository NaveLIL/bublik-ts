import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DANGEROUS_ASSIGNABLE_PERMISSIONS,
  evaluateRolePolicy,
  hasDangerousAssignablePermissions,
  type RolePolicyContext,
  type RolePolicySubject,
} from '../../src/core/RolePolicy';

const context: RolePolicyContext = {
  guildId: 'guild',
  actorCanManageRoles: true,
  actorIsGuildOwner: false,
  actorHighestPosition: 50,
  botCanManageRoles: true,
  botHighestPosition: 100,
};

function role(overrides: Partial<RolePolicySubject> = {}): RolePolicySubject {
  return {
    id: 'role',
    guildId: 'guild',
    managed: false,
    position: 10,
    ...overrides,
  } as RolePolicySubject;
}

test('role policy requires both actor and bot ManageRoles authority', () => {
  assert.deepEqual(
    evaluateRolePolicy({ ...context, actorCanManageRoles: false }, role()),
    { ok: false, reason: 'missing_manage_roles' },
  );
  assert.deepEqual(
    evaluateRolePolicy({ ...context, botCanManageRoles: false }, role()),
    { ok: false, reason: 'bot_missing_manage_roles' },
  );
});

test('role policy rejects everyone, managed and cross-guild roles', () => {
  assert.deepEqual(evaluateRolePolicy(context, role({ id: 'guild' })), { ok: false, reason: 'everyone' });
  assert.deepEqual(evaluateRolePolicy(context, role({ managed: true })), { ok: false, reason: 'managed' });
  assert.deepEqual(evaluateRolePolicy(context, role({ guildId: 'other' })), { ok: false, reason: 'wrong_guild' });
});

test('role hierarchy is strict and guild owner bypass applies only to actor hierarchy', () => {
  assert.deepEqual(
    evaluateRolePolicy(context, role({ position: context.botHighestPosition })),
    { ok: false, reason: 'bot_hierarchy' },
  );
  assert.deepEqual(
    evaluateRolePolicy(context, role({ position: context.actorHighestPosition })),
    { ok: false, reason: 'actor_hierarchy' },
  );
  assert.deepEqual(
    evaluateRolePolicy({ ...context, actorIsGuildOwner: true }, role({ position: 75 })),
    { ok: true },
  );
  assert.deepEqual(
    evaluateRolePolicy({ ...context, actorIsGuildOwner: true }, role({ position: 100 })),
    { ok: false, reason: 'bot_hierarchy' },
  );
  assert.deepEqual(evaluateRolePolicy(context, role()), { ok: true });
});

test('automatically assigned roles reject every staff permission in the shared policy', () => {
  for (const permission of DANGEROUS_ASSIGNABLE_PERMISSIONS) {
    assert.equal(hasDangerousAssignablePermissions(permission), true);
  }
  assert.equal(hasDangerousAssignablePermissions(0n), false);
});
