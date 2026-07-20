import { type MemberRoleLock, withMemberRoleLock } from '../../core/MemberRoleLock';

// Discord user IDs are decimal snowflakes, so this scoped sentinel can never
// collide with a real member lock. Reusing the renewable distributed lock
// keeps one lock implementation and one ownership protocol across processes.
const VACATION_ROLE_CONFIG_LOCK_SUBJECT = '__vacation-role-config__';

/**
 * Serialize vacation-role configuration changes with every durable transition
 * into a role-bearing vacation. Callers must acquire this lock before opening
 * a database transaction/member advisory lock; no caller may acquire it while
 * holding a real member-role lock.
 */
export function withVacationRoleConfigLock<T>(
  guildId: string,
  task: (lock: MemberRoleLock) => Promise<T>,
): Promise<T> {
  return withMemberRoleLock(
    guildId,
    VACATION_ROLE_CONFIG_LOCK_SUBJECT,
    async (lock) => {
      await lock.assertOwned();
      return task(lock);
    },
  );
}
