import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDuePlayedResetDate,
  getPrismaErrorCode,
  isCommanderAuthorized,
  isUnknownChannelError,
  isUnknownMemberError,
  isUnknownMessageError,
  LIVE_REPRIMAND_STATUSES,
  mayUsePbCommanderFallback,
  TRANSITIONAL_REPRIMAND_STATUSES,
  canBypassSquadCreationWindow,
  canCreatePbSquadAtMskMinute,
  isMinuteInHalfOpenDailyWindow,
  playedResetDisposition,
  reprimandTypeRoleConflictsWithProtectedRole,
} from '../../src/modules/regbattle/safety';

test('only authoritative Discord not-found codes permit destructive recovery', () => {
  assert.equal(isUnknownMemberError({ code: 10007 }), true);
  assert.equal(isUnknownMemberError({ code: '10007' }), true);
  assert.equal(isUnknownChannelError({ code: 10003 }), true);
  assert.equal(isUnknownMessageError({ code: 10008 }), true);

  assert.equal(isUnknownMemberError(new Error('network timeout')), false);
  assert.equal(isUnknownMemberError({ code: 50001 }), false);
  assert.equal(isUnknownChannelError({ code: 'ETIMEDOUT' }), false);
});

test('played reset catches up the latest due Moscow date after downtime', () => {
  // 19:59 UTC = 22:59 Moscow, so the 23:00 reset due is still yesterday's.
  assert.equal(getDuePlayedResetDate(new Date('2026-07-19T19:59:00.000Z'), 23), '2026-07-18');
  // 20:00 UTC = 23:00 Moscow: today's reset becomes due immediately.
  assert.equal(getDuePlayedResetDate(new Date('2026-07-19T20:00:00.000Z'), 23), '2026-07-19');
  // A restart the next morning catches up the previous evening's missed run.
  assert.equal(getDuePlayedResetDate(new Date('2026-07-20T06:00:00.000Z'), 23), '2026-07-19');
});

test('empty commander role configuration is fail-closed except ManageGuild', () => {
  assert.equal(isCommanderAuthorized([], new Set(), false), false);
  assert.equal(isCommanderAuthorized(undefined, new Set(['commander']), false), false);
  assert.equal(isCommanderAuthorized(['commander'], new Set(['commander']), false), true);
  assert.equal(isCommanderAuthorized([], new Set(), true), true);
});

test('private team squad cannot be entered through generic commander fallback', () => {
  const commanderRoles = new Set(['commander']);
  assert.equal(mayUsePbCommanderFallback(true, false, ['commander'], commanderRoles), false);
  assert.equal(mayUsePbCommanderFallback(true, true, ['commander'], commanderRoles), false);
  assert.equal(mayUsePbCommanderFallback(false, false, ['commander'], commanderRoles), true);
  assert.equal(mayUsePbCommanderFallback(false, true, [], new Set()), true);
});

test('Prisma retry classification does not confuse non-Prisma failures', () => {
  assert.equal(getPrismaErrorCode({ code: 'P2034' }), 'P2034');
  assert.equal(getPrismaErrorCode(new Error('connection lost')), null);
});

test('shared-role and recovery policies include every crash transition', () => {
  for (const status of ['granting', 'appeal_creating', 'annulling', 'appeal_resolving'] as const) {
    assert.equal((LIVE_REPRIMAND_STATUSES as readonly string[]).includes(status), true);
    assert.equal((TRANSITIONAL_REPRIMAND_STATUSES as readonly string[]).includes(status), true);
  }
  assert.equal((TRANSITIONAL_REPRIMAND_STATUSES as readonly string[]).includes('grant_cleanup'), true);
});

test('PB creation window bypass is restricted to the configured owner in dev only', () => {
  assert.equal(canBypassSquadCreationWindow('owner', false, 'owner'), false);
  assert.equal(canBypassSquadCreationWindow('owner', true, null), false);
  assert.equal(canBypassSquadCreationWindow('other', true, 'owner'), false);
  assert.equal(canBypassSquadCreationWindow('owner', true, 'owner'), true);
});

test('half-open PB preparation windows wrap midnight and include NA hours', () => {
  assert.equal(isMinuteInHalfOpenDailyWindow(23 * 60 + 59, 16 * 60 + 30, 60), true);
  assert.equal(isMinuteInHalfOpenDailyWindow(30, 16 * 60 + 30, 60), true);
  assert.equal(isMinuteInHalfOpenDailyWindow(60, 16 * 60 + 30, 60), false);

  const cases: Array<[number, boolean]> = [
    [59, true],       // 00:59 EU window
    [60, false],      // 01:00 exact end
    [3 * 60 + 29, false],
    [3 * 60 + 30, true],
    [9 * 60 + 59, true],
    [10 * 60, false],
    [16 * 60 + 29, false],
    [16 * 60 + 30, true],
  ];
  for (const [minute, expected] of cases) {
    assert.equal(canCreatePbSquadAtMskMinute(minute), expected, `minute ${minute}`);
  }
});

test('reprimand type roles cannot alias PB capabilities or the vacation marker', () => {
  const coreRoles = {
    pingRoleId: 'ping',
    inSquadRoleId: 'squad',
    playedTodayRoleId: 'played',
  };
  assert.equal(reprimandTypeRoleConflictsWithProtectedRole('ping', coreRoles, 'vacation'), true);
  assert.equal(reprimandTypeRoleConflictsWithProtectedRole('squad', coreRoles, 'vacation'), true);
  assert.equal(reprimandTypeRoleConflictsWithProtectedRole('played', coreRoles, 'vacation'), true);
  assert.equal(reprimandTypeRoleConflictsWithProtectedRole('vacation', coreRoles, 'vacation'), true);
  assert.equal(reprimandTypeRoleConflictsWithProtectedRole('warning', coreRoles, 'vacation'), false);
});

test('daily played reset is deferred without touching provenance during vacation', () => {
  assert.equal(playedResetDisposition(false), 'apply');
  assert.equal(playedResetDisposition(true), 'defer');
});
