import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolvePbPingerDisplayStatus,
  type PbPingerDisplayStatusInput,
} from '../../src/modules/regbattle/pingerDisplayStatus';

const base: PbPingerDisplayStatusInput = {
  activeSquadCount: 1,
  allFull: false,
  pingRoleConfigured: true,
  pingRolePresent: true,
  reserveChannelConfigured: true,
  massRoleSafe: true,
  canMentionRole: true,
  eligibleIndividualCount: 10,
  exclusions: { vacation: 0, played: 0, inPb: 0, bot: 0 },
  escalationCoolingDown: false,
  noProgressCount: 0,
  escalateAfter: 6,
};

test('disabled: no active notification-enabled squads', () => {
  const status = resolvePbPingerDisplayStatus({ ...base, activeSquadCount: 0 });
  assert.equal(status.mode, 'disabled');
  assert.equal(status.reason, 'no_active_squads');
  assert.equal(status.delivery, 'none');
  assert.equal(status.audience, 'none');
});

test('role_mass: safe recruiting population before no-progress escalation', () => {
  const status = resolvePbPingerDisplayStatus(base);
  assert.equal(status.mode, 'role_mass');
  assert.equal(status.reason, 'safe_population');
  assert.equal(status.delivery, 'role_mention');
  assert.equal(status.audience, 'recruiting');
});

test('individual_safe: unsafe population switches immediately to individual mentions', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    massRoleSafe: false,
    exclusions: { vacation: 3, played: 2, inPb: 1, bot: 1 },
  });
  assert.equal(status.mode, 'individual_safe');
  assert.equal(status.reason, 'unsafe_population');
  assert.equal(status.delivery, 'individual_mentions');
  assert.equal(status.conflictingExclusionCount, 7);
  assert.deepEqual(status.exclusions, { vacation: 3, played: 2, inPb: 1, bot: 1 });
});

test('individual_safe: safe role population escalates after no progress', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    noProgressCount: 6,
  });
  assert.equal(status.mode, 'individual_safe');
  assert.equal(status.reason, 'no_progress');
  assert.equal(status.delivery, 'individual_mentions');
});

test('cooldown: unsafe population does not promise individual delivery during cooldown', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    massRoleSafe: false,
    escalationCoolingDown: true,
  });
  assert.equal(status.mode, 'cooldown');
  assert.equal(status.reason, 'unsafe_population');
  assert.equal(status.delivery, 'channel_message');
});

test('safe population keeps role pings while no-progress escalation is cooling down', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    noProgressCount: 6,
    escalationCoolingDown: true,
  });
  assert.equal(status.mode, 'role_mass');
  assert.equal(status.reason, 'safe_population');
  assert.equal(status.delivery, 'role_mention');
});

test('missing mention permission uses safe individual fallback while recruiting', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    canMentionRole: false,
  });
  assert.equal(status.mode, 'individual_safe');
  assert.equal(status.reason, 'mention_permission_missing');
  assert.equal(status.delivery, 'individual_mentions');

  const coolingDown = resolvePbPingerDisplayStatus({
    ...base,
    canMentionRole: false,
    escalationCoolingDown: true,
  });
  assert.equal(coolingDown.mode, 'cooldown');
  assert.equal(coolingDown.reason, 'mention_permission_missing');
  assert.equal(coolingDown.delivery, 'channel_message');
});

test('full_role: safe FULL suggestion mentions the configured role', () => {
  const status = resolvePbPingerDisplayStatus({ ...base, allFull: true });
  assert.equal(status.mode, 'full_role');
  assert.equal(status.delivery, 'role_mention');
  assert.equal(status.audience, 'reserve');
});

test('full_channel_only: unsafe FULL suggestion stays in the channel', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    allFull: true,
    massRoleSafe: false,
    exclusions: { vacation: 1, played: 0, inPb: 8, bot: 0 },
  });
  assert.equal(status.mode, 'full_channel_only');
  assert.equal(status.reason, 'unsafe_population');
  assert.equal(status.delivery, 'channel_message');
  assert.equal(status.conflictingExclusionCount, 9);
});

test('full_channel_only: FULL suggestion exposes missing mention permission', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    allFull: true,
    canMentionRole: false,
  });
  assert.equal(status.mode, 'full_channel_only');
  assert.equal(status.reason, 'mention_permission_missing');
  assert.equal(status.delivery, 'channel_message');
});

test('unavailable: FULL suggestions require a configured reserve channel', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    allFull: true,
    reserveChannelConfigured: false,
  });
  assert.equal(status.mode, 'unavailable');
  assert.equal(status.reason, 'reserve_channel_not_configured');
  assert.equal(status.delivery, 'none');
  assert.equal(status.audience, 'reserve');
});

test('unavailable: missing role configuration and deleted role are distinguished', () => {
  const notConfigured = resolvePbPingerDisplayStatus({
    ...base,
    pingRoleConfigured: false,
    pingRolePresent: false,
  });
  assert.equal(notConfigured.mode, 'unavailable');
  assert.equal(notConfigured.reason, 'ping_role_not_configured');
  assert.equal(notConfigured.delivery, 'channel_message');

  const missing = resolvePbPingerDisplayStatus({ ...base, pingRolePresent: false });
  assert.equal(missing.mode, 'unavailable');
  assert.equal(missing.reason, 'ping_role_missing');
  assert.equal(missing.delivery, 'channel_message');
});

test('no_targets: recruiting has nobody safe to notify', () => {
  const status = resolvePbPingerDisplayStatus({
    ...base,
    massRoleSafe: false,
    eligibleIndividualCount: 0,
    exclusions: { vacation: 4, played: 5, inPb: 1, bot: 2 },
  });
  assert.equal(status.mode, 'no_targets');
  assert.equal(status.reason, 'no_eligible_targets');
  assert.equal(status.delivery, 'channel_message');
  assert.equal(status.conflictingExclusionCount, 12);
});

test('invalid counters fail closed as unavailable', () => {
  for (const input of [
    { ...base, activeSquadCount: -1 },
    { ...base, eligibleIndividualCount: Number.NaN },
    { ...base, noProgressCount: 1.5 },
    { ...base, escalateAfter: 0 },
    { ...base, exclusions: { ...base.exclusions, vacation: -1 } },
  ]) {
    const status = resolvePbPingerDisplayStatus(input);
    assert.equal(status.mode, 'unavailable');
    assert.equal(status.reason, 'invalid_input');
    assert.equal(status.delivery, 'none');
  }
});
