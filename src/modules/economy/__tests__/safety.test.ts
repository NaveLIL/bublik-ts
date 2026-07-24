import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { getBlackMarketTotal, parseBlackMarketDuelMetadata } from '../commands/blackmarket';
import {
  calculateCraftPrice,
  craftCreateClaimKey,
  getPerksJson,
  parseCompletedCraftCreateClaim,
} from '../commands/craft';
import { wantedNextDecayAfterCapture } from '../commands/capture';
import { hasDuplicateConfiguredRoles, roleIdsRequiringPolicyValidation } from '../commands/economy';
import { isImmediatelyCleanableEconomyClaim } from '../maintenance';
import { craftPublishNonce, isCraftPanelMessage, parseCraftPublishIntent } from '../craft-recovery';
import { financialLockOrder, readPersistedTransferResult } from '../profile';
import {
  calculateVoiceTickAmount,
  collectPbTierSyncUserIds,
  executePbTierRoleMutationPlan,
  hasMinimumLiveVoiceMembers,
  loadPbVoiceChannelIds,
  loadPbVoiceChannelIdsWithRetry,
  loadAuthoritativePbTierStateWithFence,
  loadFreshPbTierMemberWithFence,
  normalizeVoiceIntervalMs,
  normalizeVoiceMinMembers,
  parseVoiceRewardCursorMetadata,
  isVoiceRewardCursorDue,
  isVoicePresenceObservationEligible,
  parseVoicePresenceObservation,
  selectExpectedPbTierRole,
  voicePresenceTransitionAction,
  voiceRewardBucketKey,
  voiceRewardCursorKey,
} from '../voice-tracker';
import { isConfiguredEconomyOwner } from '../ownerImmunity';
import {
  activateEconomyCollectors,
  getActiveEconomyCollectorCount,
  registerEconomyCollector,
  stopAllEconomyCollectors,
} from '../collector-lifecycle';
import {
  DANGEROUS_ASSIGNABLE_PERMISSIONS,
  evaluateRolePolicy,
  hasDangerousAssignablePermissions,
} from '../../../core/RolePolicy';
import {
  clearCacheBypassForTests,
  isCacheBypassed,
  mutateCacheBestEffort,
  readThroughJsonCache,
} from '../cache-aside';
import {
  calculateRaidStrikeDamage,
  isRaidLaunchMessage,
  isRecoverableRaidLaunch,
  isRaidTerminalRecoveryCandidate,
  isUnknownDiscordMemberError,
  RAID_LAUNCH_LEASE_MS,
  raidMessageMarker,
} from '../raid';
import { HEIST_RUN_LEASE_MS, isRecoverableRunningHeist } from '../heist-engine';
import {
  calculateEffectiveWantedDecayMs,
  isHeistMembershipClaimReclaimable,
  wantedDecayAfterIncrement,
} from '../database';
import {
  encodeVoiceRewardTransactionTarget,
  rebuildPbVoiceSecondsFromRecords,
} from '../voice-reward-metadata';
import { calculateShopCompensation, parsePersistedShopCommission } from '../shop-expiry';
import {
  clampDirtyAmount,
  getCleanWallet,
  getMarketRefundAmount,
  getOnceOnlySettlementEffects,
} from '../safety-policy';
import { calculateAdminPbVoiceSeconds } from '../admin-profile';
import {
  mergeRetiredPbRoleIds,
  parsePbTierReconciliationMetadata,
} from '../pb-tier-reconciliation';
import { hasForbiddenEconomyRewardPermissions } from '../reward-role-policy';

test('black market charges unit price multiplied by quantity', () => {
  assert.equal(getBlackMarketTotal(125, 4), 500);
  assert.equal(getBlackMarketTotal(10_000_000, 1), 10_000_000);
});

test('black market rejects invalid and overflowing totals', () => {
  assert.throws(() => getBlackMarketTotal(0, 1), /invalid_unit_price/);
  assert.throws(() => getBlackMarketTotal(1, 0), /invalid_quantity/);
  assert.throws(() => getBlackMarketTotal(10_000_000, 1_000), /price_overflow/);
});

test('craft price and persisted perk use the same clamped value', () => {
  assert.equal(calculateCraftPrice('robBonus', 90), 155_000);
  assert.deepEqual(getPerksJson('robBonus', 90), { robBonus: 30 });
  assert.equal(calculateCraftPrice(null, null), 5_000);
});

test('craft creation claims bind one Discord interaction to one durable request', () => {
  const metadata = {
    version: 1,
    state: 'completed',
    interactionId: 'interaction-1',
    guildId: 'guild-1',
    userId: 'user-1',
    requestId: 'request-1',
  } as const;
  assert.equal(craftCreateClaimKey('guild-1', 'interaction-1'), 'economy:craft-create:guild-1:interaction-1');
  assert.deepEqual(parseCompletedCraftCreateClaim(metadata), metadata);
  assert.equal(parseCompletedCraftCreateClaim({ ...metadata, state: 'creating' }), null);
  assert.equal(parseCompletedCraftCreateClaim({ ...metadata, requestId: null }), null);
});

test('a durable settlement claim permits monetary effects exactly once', () => {
  assert.deepEqual(getOnceOnlySettlementEffects(true, 2_500, 0), {
    walletCredit: 2_500,
    governmentCredit: 0,
  });
  assert.deepEqual(getOnceOnlySettlementEffects(false, 2_500, 700), {
    walletCredit: 0,
    governmentCredit: 0,
  });
  assert.throws(() => getOnceOnlySettlementEffects(true, -1, 0), /invalid_payout/);
});

test('market rollback refunds the exact fee only to the winning state transition', () => {
  const fee = 5_000;
  assert.equal(getMarketRefundAmount(fee, true), fee);
  assert.equal(getMarketRefundAmount(fee, false), 0);
  assert.equal(-fee + getMarketRefundAmount(fee, true), 0);
  assert.throws(() => getMarketRefundAmount(-1, true), /invalid_market_fee/);
});

test('dirty wallet policy never exposes dirty funds as clean or exceeds wallet', () => {
  assert.equal(getCleanWallet(10_000, 7_500), 2_500);
  assert.equal(getCleanWallet(2_000, 5_000), 0);
  assert.equal(clampDirtyAmount(2_000, 5_000), 2_000);
  assert.equal(clampDirtyAmount(0, 500), 0);
});

test('black-market duel metadata accepts only known choices', () => {
  assert.deepEqual(parseBlackMarketDuelMetadata({
    state: 'active',
    sellerChoice: 'relocate',
    copChoice: 'gps',
  }), {
    state: 'active',
    sellerChoice: 'relocate',
    copChoice: 'gps',
    outcome: undefined,
  });
  assert.deepEqual(parseBlackMarketDuelMetadata({
    state: 'active',
    sellerChoice: 'forged',
    copChoice: 'forged',
  }), {
    state: 'active',
    sellerChoice: undefined,
    copChoice: undefined,
    outcome: undefined,
  });
});

test('claim cleanup keeps live workflows and removes only terminal claims', () => {
  assert.equal(isImmediatelyCleanableEconomyClaim('blackjack_session', { state: 'open' }), false);
  assert.equal(isImmediatelyCleanableEconomyClaim('blackjack_session', { state: 'refunded' }), true);
  assert.equal(isImmediatelyCleanableEconomyClaim('economy_deferred_wanted', { state: 'pending' }), false);
  assert.equal(isImmediatelyCleanableEconomyClaim('economy_deferred_wanted', { state: 'completed' }), true);
  assert.equal(isImmediatelyCleanableEconomyClaim('blackmarket_duel', { state: 'active' }), false);
  assert.equal(isImmediatelyCleanableEconomyClaim('blackmarket_duel', { state: 'resolved' }), true);
  assert.equal(isImmediatelyCleanableEconomyClaim('raid_boost_charge', { raidId: 'raid-1' }), true);
  assert.equal(isImmediatelyCleanableEconomyClaim('raid_strike', { state: 'completed' }), true);
  assert.equal(isImmediatelyCleanableEconomyClaim('welcome_bonus', { state: 'completed' }), false);
});

test('raid launch recovery targets only stale active rows without a message', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(
    isRecoverableRaidLaunch('active', null, new Date(now - RAID_LAUNCH_LEASE_MS), now),
    true,
  );
  assert.equal(isRecoverableRaidLaunch('pending', null, new Date(0), now), false);
  assert.equal(isRecoverableRaidLaunch('active', 'discord-message', new Date(0), now), false);
  assert.equal(isRecoverableRaidLaunch('active', null, new Date(now - 1), now), false);
});

test('raid launch recovery relinks only the bot message for the exact raid', () => {
  const botId = 'bot';
  const raidId = 'raid-123';
  assert.equal(isRaidLaunchMessage({
    author: { id: botId },
    embeds: [{ footer: { text: raidMessageMarker(raidId) } }],
  }, botId, raidId), true);
  assert.equal(isRaidLaunchMessage({
    author: { id: botId },
    components: [{ components: [{ customId: `raid:strike:${raidId}` }] }],
  }, botId, raidId), true);
  assert.equal(isRaidLaunchMessage({
    author: { id: 'another-bot' },
    embeds: [{ footer: { text: raidMessageMarker(raidId) } }],
  }, botId, raidId), false);
  assert.equal(isRaidLaunchMessage({
    author: { id: botId },
    components: [{ components: [{ customId: 'raid:strike:different-raid' }] }],
  }, botId, raidId), false);
});

test('heist recovery uses running expiresAt as a processing lease', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isRecoverableRunningHeist('running', new Date(now), now), true);
  assert.equal(isRecoverableRunningHeist('running', new Date(now + HEIST_RUN_LEASE_MS), now), false);
  assert.equal(isRecoverableRunningHeist('success', new Date(0), now), false);
});

test('heist membership claims cannot expire out from under a live owner', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now - 1), 'running', now), false);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now - 1), 'assembling', now), false);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now - 1), 'cancelled', now), true);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now - 1), null, now), true);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now + 1), 'cancelled', now), true);
  assert.equal(isHeistMembershipClaimReclaimable(new Date(now + 1), null, now), false);
});

test('raid recovery recognizes HP-zero active rows independent of Discord state', () => {
  assert.equal(isRaidTerminalRecoveryCandidate('active', 0), true);
  assert.equal(isRaidTerminalRecoveryCandidate('active', -5), true);
  assert.equal(isRaidTerminalRecoveryCandidate('active', 1), false);
  assert.equal(isRaidTerminalRecoveryCandidate('resolved', 0), false);
});

test('raid boost scales the base and combo consistently', () => {
  assert.equal(calculateRaidStrikeDamage(40, 0, false), 40);
  assert.equal(calculateRaidStrikeDamage(40, 2, false), 48);
  assert.equal(calculateRaidStrikeDamage(40, 2, true), 72);
  assert.equal(calculateRaidStrikeDamage(40, 99, true), 90);
});

test('only Discord Unknown Member is authoritative absence evidence', () => {
  assert.equal(isUnknownDiscordMemberError({ code: 10_007 }), true);
  assert.equal(isUnknownDiscordMemberError({ code: 50_013 }), false);
  assert.equal(isUnknownDiscordMemberError(new Error('network')), false);
});

test('multi-account locks use one locale-independent order', () => {
  assert.deepEqual(financialLockOrder(['z-user', 'a-user', 'z-user', 'government']), [
    'a-user',
    'government',
    'z-user',
  ]);
});

test('a retried transfer reuses only the exact persisted result', () => {
  const metadata = { senderId: 'a', receiverId: 'b', amount: 1_000, tax: 50, received: 950 };
  assert.deepEqual(readPersistedTransferResult(metadata, 'a', 'b', 1_000), { tax: 50 });
  assert.equal(readPersistedTransferResult(metadata, 'b', 'a', 1_000), null);
  assert.equal(readPersistedTransferResult({ ...metadata, received: 951 }, 'a', 'b', 1_000), null);
  assert.equal(readPersistedTransferResult({ ...metadata, tax: 2_000 }, 'a', 'b', 1_000), null);
});

test('capture clears the wanted decay timestamp only after the final star', () => {
  assert.equal(wantedNextDecayAfterCapture(1), null);
  assert.equal(wantedNextDecayAfterCapture(0), null);
  assert.equal(wantedNextDecayAfterCapture(2), undefined);
});

test('owner immunity is configuration-backed and empty config grants nobody immunity', () => {
  assert.equal(isConfiguredEconomyOwner('owner', 'owner'), true);
  assert.equal(isConfiguredEconomyOwner('owner', ''), false);
  assert.equal(isConfiguredEconomyOwner('owner', null), false);
  assert.equal(isConfiguredEconomyOwner('other', 'owner'), false);
});

test('cache-aside falls back to the durable source when Redis read or JSON fails', async () => {
  const phases: string[] = [];
  let sourceReads = 0;
  const fromReadFailure = await readThroughJsonCache({
    readCache: async () => { throw new Error('redis_down'); },
    readSource: async () => { sourceReads += 1; return { enabled: true }; },
    serialize: (value) => value,
    writeCache: async () => { throw new Error('redis_still_down'); },
    onCacheFailure: (phase) => phases.push(phase),
  });
  assert.deepEqual(fromReadFailure, { enabled: true });
  assert.equal(sourceReads, 1);
  assert.deepEqual(phases, ['read', 'write']);

  const fromCorruptJson = await readThroughJsonCache({
    readCache: async () => '{not-json',
    readSource: async () => ({ enabled: false }),
    serialize: (value) => value,
    writeCache: async () => undefined,
    onCacheFailure: (phase) => phases.push(phase),
  });
  assert.deepEqual(fromCorruptJson, { enabled: false });
  assert.equal(phases.at(-1), 'decode');

  const fromWrongIdentity = await readThroughJsonCache({
    readCache: async () => JSON.stringify({ guildId: 'another-guild', enabled: true }),
    readSource: async () => ({ guildId: 'guild', enabled: false }),
    serialize: (value) => value,
    writeCache: async () => undefined,
    validateCached: (value) => Boolean(
      value
      && typeof value === 'object'
      && (value as { guildId?: unknown }).guildId === 'guild'
    ),
    onCacheFailure: (phase) => phases.push(phase),
  });
  assert.deepEqual(fromWrongIdentity, { guildId: 'guild', enabled: false });
  assert.equal(phases.at(-1), 'decode');
});

test('cache invalidation is best-effort after a durable write', async () => {
  clearCacheBypassForTests();
  const phases: string[] = [];
  await mutateCacheBestEffort(
    async () => { throw new Error('redis_down'); },
    (phase) => phases.push(phase),
  );
  assert.deepEqual(phases, ['invalidate']);
});

test('failed invalidation bypasses stale Redis until a durable refill succeeds', async () => {
  clearCacheBypassForTests();
  const key = 'economy:config:guild';
  let cacheReads = 0;
  await mutateCacheBestEffort(
    async () => { throw new Error('network_partition'); },
    undefined,
    key,
  );
  assert.equal(isCacheBypassed(key), true);

  const result = await readThroughJsonCache({
    coherenceKey: key,
    readCache: async () => {
      cacheReads += 1;
      return JSON.stringify({ enabled: true });
    },
    readSource: async () => ({ enabled: false }),
    serialize: (value) => value,
    writeCache: async () => undefined,
  });
  assert.deepEqual(result, { enabled: false });
  assert.equal(cacheReads, 0);
  assert.equal(isCacheBypassed(key), false);
});

test('voice payout and once-only bucket use the configured interval', () => {
  assert.equal(normalizeVoiceIntervalMs(300_000), 300_000);
  assert.equal(normalizeVoiceIntervalMs(0), 600_000);
  assert.equal(calculateVoiceTickAmount(50, 600_000), 8);
  assert.equal(calculateVoiceTickAmount(50, 300_000), 4);
  const first = voiceRewardBucketKey('g', 'u', 600_000, 1_000_000);
  assert.equal(first, voiceRewardBucketKey('g', 'u', 600_000, 1_100_000));
  assert.notEqual(first, voiceRewardBucketKey('g', 'u', 600_000, 1_200_000));
});

test('durable voice cursor fences restarts, bucket boundaries and interval changes', () => {
  const cursor = parseVoiceRewardCursorMetadata({
    version: 1,
    lastPaidAtMs: 1_199_999,
    lastIntervalMs: 600_000,
    lastChannelId: 'pb-1',
    lastIsPb: true,
    lastAmount: 25,
    lastBucketStartMs: 600_000,
  });
  assert.ok(cursor);
  assert.equal(voiceRewardCursorKey('g', 'u'), voiceRewardCursorKey('g', 'u'));

  // A restart just across a fixed-window boundary must not pay again.
  assert.equal(isVoiceRewardCursorDue(cursor, 1, 1_200_001, 600_000), false);
  // Changing to a shorter interval also waits from the last committed payout.
  assert.equal(isVoiceRewardCursorDue(cursor, 1, 1_499_998, 300_000), false);
  assert.equal(isVoiceRewardCursorDue(cursor, 1, 1_499_999, 300_000), true);
  // A channel move creates a newer continuous-presence anchor.
  assert.equal(isVoiceRewardCursorDue(cursor, 1_450_000, 1_749_999, 300_000), false);
  assert.equal(isVoiceRewardCursorDue(cursor, 1_450_000, 1_750_000, 300_000), true);
  // Clock regression and malformed cursor state are fail-closed.
  assert.equal(isVoiceRewardCursorDue(cursor, 1, 1_000_000, 300_000), false);
  assert.equal(parseVoiceRewardCursorMetadata({ version: 1, lastPaidAtMs: -1 }), null);
});

test('voice presence generations fail closed on legacy state, hops and AFK recovery', () => {
  assert.equal(parseVoicePresenceObservation(1_000_000), null);
  assert.equal(parseVoicePresenceObservation('1000000'), null);
  const observation = parseVoicePresenceObservation({
    version: 4,
    ownerId: 'owner-0123456789abcdef',
    channelId: 'voice-1',
    sessionId: 'session-1',
    observedAtMs: 1_000_000,
    generation: '01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.ok(observation);
  assert.equal(
    isVoicePresenceObservationEligible(observation, 'voice-1', 'session-1', 1_599_999, 600_000),
    false,
  );
  assert.equal(
    isVoicePresenceObservationEligible(observation, 'voice-1', 'session-1', 1_600_000, 600_000),
    true,
  );
  assert.equal(
    isVoicePresenceObservationEligible(observation, 'voice-2', 'session-1', 1_600_000, 600_000),
    false,
  );

  assert.equal(voicePresenceTransitionAction(null, 'voice-1', false, false, null, 's1'), 'reset');
  assert.equal(voicePresenceTransitionAction('voice-1', 'voice-2', false, false, 's1', 's1'), 'reset');
  assert.equal(voicePresenceTransitionAction('voice-1', 'voice-1', false, true, 's1', 's1'), 'delete');
  assert.equal(voicePresenceTransitionAction('voice-1', 'voice-1', true, false, 's1', 's1'), 'reset');
  assert.equal(voicePresenceTransitionAction('voice-1', 'voice-1', false, false, 's1', 's1'), 'preserve');

  // Unmuting immediately before a tick creates a fresh generation; it cannot
  // reuse the pre-AFK interval and therefore is not yet payable.
  const afterUnmute = parseVoicePresenceObservation({
    version: 4,
    ownerId: 'owner-0123456789abcdef',
    channelId: 'voice-1',
    sessionId: 'session-1',
    observedAtMs: 1_600_000,
    generation: 'fedcba98-7654-3210-fedc-ba9876543210',
  });
  assert.ok(afterUnmute);
  assert.equal(
    isVoicePresenceObservationEligible(afterUnmute, 'voice-1', 'session-1', 1_600_001, 600_000),
    false,
  );
});

test('voice social threshold counts live humans before individual eligibility', () => {
  assert.equal(normalizeVoiceMinMembers(2), 2);
  assert.equal(normalizeVoiceMinMembers(0), 2);
  assert.equal(hasMinimumLiveVoiceMembers(2, 2), true);
  assert.equal(hasMinimumLiveVoiceMembers(1, 2), false);
});

test('PB voice topology failure defers payout instead of silently downgrading it', async () => {
  await assert.rejects(loadPbVoiceChannelIds('guild', ['economy-pb'], {
    loadChannelIds: async () => { throw new Error('transient database failure'); },
    loadConfig: async () => ({ reserveChannelId: 'reserve' }),
  }));

  assert.deepEqual(
    [...await loadPbVoiceChannelIds('guild', ['economy-pb', 'squad'], {
      loadChannelIds: async () => ['squad'],
      loadConfig: async () => ({ reserveChannelId: 'reserve' }),
    })].sort(),
    ['economy-pb', 'reserve', 'squad'],
  );
});

test('PB voice topology retries in-cycle without manufacturing an empty topology', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await loadPbVoiceChannelIdsWithRetry('guild', ['economy-pb'], {
    loadChannelIds: async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient database failure');
      return ['squad'];
    },
    loadConfig: async () => ({ reserveChannelId: 'reserve' }),
  }, {
    maxAttempts: 3,
    delaysMs: [10, 20],
    wait: async (delayMs) => { waits.push(delayMs); },
  });
  assert.deepEqual([...result].sort(), ['economy-pb', 'reserve', 'squad']);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);

  await assert.rejects(loadPbVoiceChannelIdsWithRetry('guild', [], {
    loadChannelIds: async () => { throw new Error('still unavailable'); },
    loadConfig: async () => null,
  }, {
    maxAttempts: 2,
    delaysMs: [0],
    wait: async () => undefined,
  }), /still unavailable/);
});

test('PB tier role mutations validate the replacement and fence every Discord mutation', async () => {
  const events: string[] = [];
  const granted = await executePbTierRoleMutationPlan({
    targetRoleId: 'tier-2',
    targetAlreadyHeld: false,
    roleIdsToRemove: ['tier-1'],
  }, {
    fetchSafeTargetRole: async (roleId) => {
      events.push(`fetch:${roleId}`);
      return { id: roleId };
    },
    assertLockOwned: async () => { events.push('assert'); },
    addTargetRole: async (role) => { events.push(`add:${role.id}`); },
    removeRole: async (roleId) => { events.push(`remove:${roleId}`); },
  });

  assert.deepEqual(granted, { id: 'tier-2' });
  assert.deepEqual(events, [
    'fetch:tier-2',
    'assert',
    'add:tier-2',
    'assert',
    'remove:tier-1',
  ]);
});

test('PB tier role mutations retain the old tier when target validation fails', async () => {
  const events: string[] = [];
  await assert.rejects(executePbTierRoleMutationPlan({
    targetRoleId: 'unsafe-tier',
    targetAlreadyHeld: false,
    roleIdsToRemove: ['current-tier'],
  }, {
    fetchSafeTargetRole: async () => {
      events.push('fetch');
      throw new Error('unsafe role');
    },
    assertLockOwned: async () => { events.push('assert'); },
    addTargetRole: async () => { events.push('add'); },
    removeRole: async () => { events.push('remove'); },
  }), /unsafe role/);
  assert.deepEqual(events, ['fetch']);
});

test('PB tier reconciliation preserves a retired role when the configured replacement is missing', async () => {
  const expected = selectExpectedPbTierRole(50 * 3600, ['missing-new-tier']);
  assert.deepEqual(expected, { roleId: 'missing-new-tier', tierIndex: 0 });
  assert.ok(expected);

  const events: string[] = [];
  await assert.rejects(executePbTierRoleMutationPlan({
    targetRoleId: expected.roleId,
    targetAlreadyHeld: false,
    roleIdsToRemove: ['safe-retired-tier'],
  }, {
    fetchSafeTargetRole: async () => {
      events.push('fetch-missing');
      throw new Error('role_missing');
    },
    assertLockOwned: async () => { events.push('assert'); },
    addTargetRole: async () => { events.push('add'); },
    removeRole: async () => { events.push('remove-retired'); },
  }), /role_missing/);

  assert.deepEqual(events, ['fetch-missing']);
});

test('PB tier reconciliation revalidates a held replacement and preserves the retired role when unsafe', async () => {
  const expected = selectExpectedPbTierRole(50 * 3600, ['unsafe-new-tier']);
  assert.deepEqual(expected, { roleId: 'unsafe-new-tier', tierIndex: 0 });
  assert.ok(expected);

  const events: string[] = [];
  await assert.rejects(executePbTierRoleMutationPlan({
    targetRoleId: expected.roleId,
    targetAlreadyHeld: true,
    roleIdsToRemove: ['safe-retired-tier'],
  }, {
    fetchSafeTargetRole: async () => {
      events.push('fetch-unsafe');
      throw new Error('forbidden_permissions');
    },
    assertLockOwned: async () => { events.push('assert'); },
    addTargetRole: async () => { events.push('add'); },
    removeRole: async () => { events.push('remove-retired'); },
  }), /forbidden_permissions/);

  assert.deepEqual(events, ['fetch-unsafe']);
});

test('PB tier promotion preserves the clone returned by add while old roles are removed singly', async () => {
  let roleState = new Set(['tier-1', 'unrelated']);
  await executePbTierRoleMutationPlan({
    targetRoleId: 'tier-2',
    targetAlreadyHeld: false,
    roleIdsToRemove: ['tier-1'],
  }, {
    fetchSafeTargetRole: async (roleId) => roleId,
    assertLockOwned: async () => undefined,
    addTargetRole: async (roleId) => {
      // discord.js singular add returns a clone instead of mutating the source.
      roleState = new Set([...roleState, roleId]);
    },
    removeRole: async (roleId) => {
      // A singular DELETE preserves every role in the latest returned state.
      roleState = new Set([...roleState].filter((held) => held !== roleId));
    },
  });
  assert.deepEqual([...roleState].sort(), ['tier-2', 'unrelated']);
});

test('PB tier authoritative state is loaded only inside a live member-role fence', async () => {
  const events: string[] = [];
  const state = await loadAuthoritativePbTierStateWithFence(
    async () => { events.push('assert'); },
    async () => {
      events.push('load');
      return { pbVoiceSeconds: 180_000, pbRoleIds: ['tier-1'] };
    },
  );
  assert.deepEqual(events, ['assert', 'load', 'assert']);
  assert.equal(state.pbVoiceSeconds, 180_000);
});

test('PB tier member state is force-loaded only inside a live member-role fence', async () => {
  const events: string[] = [];
  const member = await loadFreshPbTierMemberWithFence(
    async () => { events.push('assert'); },
    async () => {
      events.push('fetch');
      return { id: 'member' };
    },
  );
  assert.deepEqual(events, ['assert', 'fetch', 'assert']);
  assert.deepEqual(member, { id: 'member' });
});

test('PB tier bulk candidates include zero-hour and missing-profile role holders', () => {
  const candidates = collectPbTierSyncUserIds(
    ['positive-profile'],
    [
      { userId: 'positive-profile', roleIds: [] },
      { userId: 'zero-hour-holder', roleIds: ['tier-1'] },
      { userId: 'missing-profile-holder', roleIds: ['tier-2'] },
      { userId: 'unrelated-member', roleIds: ['other-role'] },
    ],
    ['tier-1', 'tier-2'],
  );
  assert.deepEqual([...candidates].sort(), [
    'missing-profile-holder',
    'positive-profile',
    'zero-hour-holder',
  ]);
});

test('PB voice rebuild uses exact v1 seconds and an explicit legacy fallback', () => {
  assert.equal(rebuildPbVoiceSecondsFromRecords([
    { targetId: encodeVoiceRewardTransactionTarget(300, true), details: 'PB reward' },
    { targetId: encodeVoiceRewardTransactionTarget(900, true), details: 'PB reward' },
    { targetId: encodeVoiceRewardTransactionTarget(300, false), details: 'normal reward' },
    { targetId: null, details: 'ПБ-войс' },
    { targetId: 'voice-reward:v1:pb:broken', details: 'ПБ-войс' },
  ]), 1_800);
});

test('admin PB-hour changes use the locked fresh value and preserve operation order', () => {
  assert.equal(calculateAdminPbVoiceSeconds(3_600, null, null, 2), 10_800);
  assert.equal(calculateAdminPbVoiceSeconds(3_600, 7_200, null, 1), 10_800);
  assert.equal(calculateAdminPbVoiceSeconds(3_600, 7_200, 5, 1), 21_600);
  assert.throws(
    () => calculateAdminPbVoiceSeconds(0, null, 1_000_000, null),
    /invalid_pb_voice_seconds/,
  );
});

test('retired PB roles survive replacements until durable reconciliation completes', () => {
  assert.deepEqual(
    mergeRetiredPbRoleIds(['old-a', 'kept'], ['older', 'kept'], ['kept', 'new']),
    ['old-a', 'older'],
  );
  assert.deepEqual(parsePbTierReconciliationMetadata({
    version: 1,
    retiredRoleIds: ['old-b', 'old-a', 'old-b'],
  }), {
    version: 1,
    retiredRoleIds: ['old-a', 'old-b'],
  });
  assert.equal(parsePbTierReconciliationMetadata({ version: 1, retiredRoleIds: [''] }), null);
});

test('wanted increments initialize decay and every following star keeps the user multiplier', () => {
  const base = 48 * 60 * 60_000;
  const effective = calculateEffectiveWantedDecayMs(base, 0.5);
  assert.equal(effective, 24 * 60 * 60_000);
  const now = Date.UTC(2026, 0, 1);
  assert.equal(wantedDecayAfterIncrement(null, now, effective).getTime(), now + effective);
  const existing = new Date(now + 1234);
  assert.equal(wantedDecayAfterIncrement(existing, now, effective), existing);
});

test('shop compensation conserves currency even after seller spent commission', () => {
  assert.deepEqual(calculateShopCompensation(10_000, 8_000, 8_000), {
    reversedCommission: 8_000,
    buyerRefund: 10_000,
  });
  assert.deepEqual(calculateShopCompensation(10_000, 8_000, 3_000), {
    reversedCommission: 3_000,
    buyerRefund: 5_000,
  });
  assert.equal(-10_000 + 8_000 - 3_000 + 5_000, 0);
  assert.deepEqual(parsePersistedShopCommission({
    purchaseId: 'purchase', buyerId: 'buyer', amount: 8_000,
  }), { purchaseId: 'purchase', buyerId: 'buyer', amount: 8_000 });
  assert.equal(parsePersistedShopCommission({ purchaseId: 'purchase', buyerId: 'buyer', amount: -1 }), null);
});

test('craft recovery accepts only the exact bot panel and persists a stable nonce', () => {
  const requestId = 'request-1';
  const exact = {
    author: { id: 'bot' },
    embeds: [{ footer: { text: `craft-request:${requestId}` } }],
    components: [{ components: [
      { customId: `eco:craft:approve:${requestId}` },
      { customId: `eco:craft:reject:${requestId}` },
    ] }],
  };
  assert.equal(isCraftPanelMessage(exact, 'bot', requestId), true);
  assert.equal(isCraftPanelMessage({ ...exact, author: { id: 'user' } }, 'bot', requestId), false);
  assert.equal(isCraftPanelMessage({ ...exact, components: [] }, 'bot', requestId), false);
  assert.equal(craftPublishNonce(requestId), craftPublishNonce(requestId));
  assert.equal(craftPublishNonce(requestId).length, 24);
  assert.deepEqual(parseCraftPublishIntent({
    version: 1,
    requestId,
    guildId: 'g',
    channelId: 'c',
    nonce: craftPublishNonce(requestId),
    state: 'pending',
  })?.requestId, requestId);
});

test('economy collectors are centrally stopped on module unload', () => {
  let stoppedWith: string | undefined;
  activateEconomyCollectors();
  registerEconomyCollector({
    stop(reason?: string) { stoppedWith = reason; },
    once() { return undefined; },
  });
  assert.equal(getActiveEconomyCollectorCount(), 1);
  stopAllEconomyCollectors();
  assert.equal(stoppedWith, 'module_unload');
  assert.equal(getActiveEconomyCollectorCount(), 0);
});

test('role policy blocks managed, everyone and hierarchy-confused assignments', () => {
  const context = {
    guildId: 'guild',
    actorCanManageRoles: true,
    actorIsGuildOwner: false,
    actorHighestPosition: 50,
    botCanManageRoles: true,
    botHighestPosition: 100,
  };
  assert.deepEqual(evaluateRolePolicy(context, {
    id: 'role', guildId: 'guild', managed: false, position: 40,
  }), { ok: true });
  assert.deepEqual(evaluateRolePolicy(context, {
    id: 'role', guildId: 'guild', managed: false, position: 50,
  }), { ok: false, reason: 'actor_hierarchy' });
  assert.deepEqual(evaluateRolePolicy(context, {
    id: 'guild', guildId: 'guild', managed: false, position: 0,
  }), { ok: false, reason: 'everyone' });
  assert.deepEqual(evaluateRolePolicy(context, {
    id: 'managed', guildId: 'guild', managed: true, position: 1,
  }), { ok: false, reason: 'managed' });
  assert.equal(hasDuplicateConfiguredRoles(['tier-1', 'tier-2', 'tier-1']), true);
  assert.equal(hasDuplicateConfiguredRoles(['tier-1', '', 'tier-2']), false);
  assert.deepEqual(roleIdsRequiringPolicyValidation(['tier-1', '', 'tier-2', 'tier-1']), [
    'tier-1',
    'tier-2',
  ]);
  assert.equal(hasDangerousAssignablePermissions(DANGEROUS_ASSIGNABLE_PERMISSIONS[0]), true);
  assert.equal(hasDangerousAssignablePermissions(0n), false);
});

test('economy reward roles allow member permissions but reject staff authority', () => {
  const ordinaryMemberPermissions =
    PermissionsBitField.Flags.ViewChannel |
    PermissionsBitField.Flags.SendMessages |
    PermissionsBitField.Flags.CreatePublicThreads |
    PermissionsBitField.Flags.Connect |
    PermissionsBitField.Flags.Speak;
  assert.equal(hasForbiddenEconomyRewardPermissions(ordinaryMemberPermissions), false);
  assert.equal(
    hasForbiddenEconomyRewardPermissions(
      ordinaryMemberPermissions | PermissionsBitField.Flags.ManageMessages,
    ),
    true,
  );
  assert.equal(hasForbiddenEconomyRewardPermissions(PermissionsBitField.Flags.MoveMembers), true);
});
