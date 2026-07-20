/**
 * Presentation-neutral view of the notification strategy used by the PB pinger.
 *
 * The resolver is deliberately pure: callers collect live Discord/Redis state,
 * while embeds and other UIs decide how to describe the returned mode.
 */
export type PbPingerDisplayMode =
  | 'disabled'
  | 'role_mass'
  | 'individual_safe'
  | 'cooldown'
  | 'full_role'
  | 'full_channel_only'
  | 'unavailable'
  | 'no_targets';

export type PbPingerDisplayReason =
  | 'no_active_squads'
  | 'ping_role_not_configured'
  | 'ping_role_missing'
  | 'reserve_channel_not_configured'
  | 'mention_permission_missing'
  | 'safe_population'
  | 'unsafe_population'
  | 'no_progress'
  | 'no_eligible_targets'
  | 'invalid_input';

export type PbPingerDelivery =
  | 'none'
  | 'role_mention'
  | 'individual_mentions'
  | 'channel_message';

export type PbPingerAudience = 'none' | 'recruiting' | 'reserve';

export interface PbPingerExclusionCounts {
  vacation: number;
  played: number;
  inPb: number;
  bot: number;
}

export interface PbPingerDisplayStatusInput {
  activeSquadCount: number;
  allFull: boolean;
  pingRoleConfigured: boolean;
  pingRolePresent: boolean;
  reserveChannelConfigured: boolean;
  massRoleSafe: boolean;
  canMentionRole: boolean;
  eligibleIndividualCount: number;
  exclusions: PbPingerExclusionCounts;
  escalationCoolingDown: boolean;
  noProgressCount: number;
  escalateAfter: number;
}

export interface PbPingerDisplayStatus {
  mode: PbPingerDisplayMode;
  reason: PbPingerDisplayReason;
  delivery: PbPingerDelivery;
  audience: PbPingerAudience;
  activeSquadCount: number;
  allFull: boolean;
  eligibleIndividualCount: number;
  exclusions: PbPingerExclusionCounts;
  conflictingExclusionCount: number;
  noProgressCount: number;
  escalateAfter: number;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidInput(input: PbPingerDisplayStatusInput): boolean {
  return isCount(input.activeSquadCount) &&
    isCount(input.eligibleIndividualCount) &&
    isCount(input.noProgressCount) &&
    Number.isSafeInteger(input.escalateAfter) && input.escalateAfter > 0 &&
    isCount(input.exclusions.vacation) &&
    isCount(input.exclusions.played) &&
    isCount(input.exclusions.inPb) &&
    isCount(input.exclusions.bot);
}

function result(
  input: PbPingerDisplayStatusInput,
  mode: PbPingerDisplayMode,
  reason: PbPingerDisplayReason,
  delivery: PbPingerDelivery,
  audience: PbPingerAudience,
): PbPingerDisplayStatus {
  const exclusions = { ...input.exclusions };
  return {
    mode,
    reason,
    delivery,
    audience,
    activeSquadCount: input.activeSquadCount,
    allFull: input.allFull,
    eligibleIndividualCount: input.eligibleIndividualCount,
    exclusions,
    conflictingExclusionCount:
      exclusions.vacation + exclusions.played + exclusions.inPb + exclusions.bot,
    noProgressCount: input.noProgressCount,
    escalateAfter: input.escalateAfter,
  };
}

/**
 * Selects the strategy that the pinger can currently use.
 *
 * Recruiting falls back to individually revalidated mentions immediately when
 * a role mention would include an excluded member. A safe role population is
 * escalated only after the configured no-progress threshold. FULL suggestions
 * do not have an individual reserve-ping state machine, so an unsafe role is
 * reported honestly as a channel-only announcement.
 */
export function resolvePbPingerDisplayStatus(
  input: PbPingerDisplayStatusInput,
): PbPingerDisplayStatus {
  if (!isValidInput(input)) {
    return result(input, 'unavailable', 'invalid_input', 'none', 'none');
  }

  if (input.activeSquadCount === 0) {
    return result(input, 'disabled', 'no_active_squads', 'none', 'none');
  }

  const audience: PbPingerAudience = input.allFull ? 'reserve' : 'recruiting';

  if (input.allFull && !input.reserveChannelConfigured) {
    return result(
      input,
      'unavailable',
      'reserve_channel_not_configured',
      'none',
      audience,
    );
  }

  if (!input.pingRoleConfigured) {
    return result(
      input,
      'unavailable',
      'ping_role_not_configured',
      'channel_message',
      audience,
    );
  }
  if (!input.pingRolePresent) {
    return result(input, 'unavailable', 'ping_role_missing', 'channel_message', audience);
  }

  if (input.allFull) {
    if (input.massRoleSafe && input.canMentionRole && input.eligibleIndividualCount > 0) {
      return result(input, 'full_role', 'safe_population', 'role_mention', audience);
    }
    const reason: PbPingerDisplayReason = input.canMentionRole
      ? 'unsafe_population'
      : 'mention_permission_missing';
    return result(input, 'full_channel_only', reason, 'channel_message', audience);
  }

  if (input.eligibleIndividualCount === 0) {
    return result(input, 'no_targets', 'no_eligible_targets', 'channel_message', audience);
  }

  if (!input.massRoleSafe || !input.canMentionRole) {
    const reason: PbPingerDisplayReason = input.canMentionRole
      ? 'unsafe_population'
      : 'mention_permission_missing';
    if (input.escalationCoolingDown) {
      return result(input, 'cooldown', reason, 'channel_message', audience);
    }
    return result(
      input,
      'individual_safe',
      reason,
      'individual_mentions',
      audience,
    );
  }

  const noProgressEscalation = input.noProgressCount >= input.escalateAfter;
  if (noProgressEscalation && !input.escalationCoolingDown) {
    return result(input, 'individual_safe', 'no_progress', 'individual_mentions', audience);
  }

  return result(input, 'role_mass', 'safe_population', 'role_mention', audience);
}
