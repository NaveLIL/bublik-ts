import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISBAND_CHECK_MS,
  MEMBER_KICK_RECOVERY_CHECK_MS,
  MEMBER_KICK_RECOVERY_LEASE_MS,
  PollStatus,
  isTeamOperationalStatus,
} from '../src/modules/teams/constants';
import {
  canCastPollVote,
  canReviewApplication,
  getMemberSelectLimits,
  mustPreserveCreationAfterFailedMessageLink,
  normalizeReadyTime,
  projectPollVotes,
} from '../src/modules/teams/policy';
import { parsePendingTeamMemberKick } from '../src/modules/teams/database';

test('empty approver role configuration is fail-closed for ordinary members', () => {
  assert.equal(canReviewApplication({
    isAdministrator: false,
    canManageGuild: false,
    roleIds: ['member'],
  }, []), false);
});

test('administrators and ManageGuild retain application review access', () => {
  assert.equal(canReviewApplication({
    isAdministrator: true,
    canManageGuild: false,
    roleIds: [],
  }, []), true);
  assert.equal(canReviewApplication({
    isAdministrator: false,
    canManageGuild: true,
    roleIds: [],
  }, []), true);
});

test('configured approver roles are matched explicitly', () => {
  assert.equal(canReviewApplication({
    isAdministrator: false,
    canManageGuild: false,
    roleIds: ['reviewer'],
  }, ['reviewer']), true);
  assert.equal(canReviewApplication({
    isAdministrator: false,
    canManageGuild: false,
    roleIds: ['member'],
  }, ['reviewer']), false);
});

test('team size respects Discord user-select limit plus leader', () => {
  assert.deepEqual(getMemberSelectLimits(26), { min: 25, max: 25 });
  assert.deepEqual(getMemberSelectLimits(10), { min: 9, max: 25 });
  assert.throws(() => getMemberSelectLimits(27), RangeError);
  assert.throws(() => getMemberSelectLimits(1), RangeError);
});

test('poll voting requires both active state and current guild membership', () => {
  assert.equal(canCastPollVote(PollStatus.ACTIVE, true), true);
  assert.equal(canCastPollVote(PollStatus.ACTIVE, false), false);
  assert.equal(canCastPollVote(PollStatus.CLOSED, true), false);
});

test('failed creation-message CAS preserves linked or advanced durable state', () => {
  assert.equal(mustPreserveCreationAfterFailedMessageLink(null), true);
  assert.equal(mustPreserveCreationAfterFailedMessageLink({
    messageId: 'discord-message',
    status: 'pending',
    team: { status: 'forming' },
  }), true);
  assert.equal(mustPreserveCreationAfterFailedMessageLink({
    messageId: null,
    status: 'approved',
    team: { status: 'active' },
  }), true);
  assert.equal(mustPreserveCreationAfterFailedMessageLink({
    messageId: null,
    status: 'pending',
    team: { status: 'forming' },
  }), false);
});

test('member-kick recovery runs independently of the hourly disband sweep', () => {
  assert.equal(MEMBER_KICK_RECOVERY_CHECK_MS, 60_000);
  assert.equal(MEMBER_KICK_RECOVERY_LEASE_MS, 120_000);
  assert.ok(MEMBER_KICK_RECOVERY_CHECK_MS < DISBAND_CHECK_MS);
});

test('durable cleanup states cannot accept leader or membership mutations', () => {
  assert.equal(isTeamOperationalStatus('forming'), true);
  assert.equal(isTeamOperationalStatus('active'), true);
  assert.equal(isTeamOperationalStatus('disbanding'), true);
  assert.equal(isTeamOperationalStatus('creation_cleanup'), false);
  assert.equal(isTeamOperationalStatus('deleting'), false);
  assert.equal(isTeamOperationalStatus('disbanded'), false);
});

test('ready time normalization rejects impossible values', () => {
  assert.equal(normalizeReadyTime('8.05'), '08:05');
  assert.equal(normalizeReadyTime('1830'), '18:30');
  assert.equal(normalizeReadyTime('24:00'), null);
  assert.equal(normalizeReadyTime('18:99'), null);
  assert.equal(normalizeReadyTime(''), null);
});

test('poll rows project deterministically into the legacy embed shape', () => {
  assert.deepEqual(projectPollVotes([
    { userId: 'yes-with-time', vote: 'yes', readyTime: '18:30' },
    { userId: 'no', vote: 'no', readyTime: '19:00' },
    { userId: 'yes-without-time', vote: 'yes', readyTime: null },
  ]), {
    yesUserIds: ['yes-with-time', 'yes-without-time'],
    noUserIds: ['no'],
    voteTimes: { 'yes-with-time': '18:30', 'yes-without-time': null },
  });
});

test('durable vote rows override legacy active-poll arrays during migration', () => {
  assert.deepEqual(projectPollVotes([
    { userId: 'changed', vote: 'no', readyTime: null },
  ], {
    yesUserIds: ['legacy', 'changed'],
    noUserIds: [],
    voteTimes: { legacy: '18:00', changed: '19:00' },
  }), {
    yesUserIds: ['legacy'],
    noUserIds: ['changed'],
    voteTimes: { legacy: '18:00' },
  });
});

test('durable team-kick recovery accepts only complete scoped metadata', () => {
  assert.deepEqual(parsePendingTeamMemberKick({
    key: 'team-member-kick:membership',
    guildId: 'guild',
    userId: 'member',
    metadata: { teamId: 'team', roleId: 'role', teamName: 'Alpha' },
  }), {
    key: 'team-member-kick:membership',
    guildId: 'guild',
    userId: 'member',
    teamId: 'team',
    roleId: 'role',
    teamName: 'Alpha',
  });
  assert.equal(parsePendingTeamMemberKick({
    key: 'broken',
    guildId: 'guild',
    userId: 'member',
    metadata: { teamId: 'team', roleId: null, teamName: 'Alpha' },
  }), null);
  assert.equal(parsePendingTeamMemberKick({
    key: 'broken',
    guildId: null,
    userId: 'member',
    metadata: { teamId: 'team', roleId: 'role', teamName: 'Alpha' },
  }), null);
});
