import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { recoverStaleBlackjackSessions } from './commands/blackjack';

const TASK = 'economy:maintenance';
const INTERVAL_MS = 60 * 60_000;
const ECONOMY_EXPIRING_SCOPES = [
  'blackjack_session',
  'blackjack_settlement',
  'heist_membership',
  'economy_deferred_wanted',
  'blackmarket_duel',
  'raid_boost_purchase',
  'raid_boost_charge',
  'raid_sabotage_purchase',
  'raid_sabotage_stun',
  'raid_strike',
  'voice_reward_bucket',
] as const;
const RAID_EFFECT_SCOPES = new Set([
  'raid_boost_purchase',
  'raid_boost_charge',
  'raid_sabotage_purchase',
  'raid_sabotage_stun',
  'raid_strike',
]);
const TERMINAL_HEIST_STATES = new Set(['success', 'fail', 'cancelled', 'expired']);

const log = logger.child('Economy:Maintenance');

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isImmediatelyCleanableEconomyClaim(scope: string, metadata: unknown): boolean {
  const parsed = metadataRecord(metadata);
  if (scope === 'blackjack_settlement') return true;
  if (scope === 'blackjack_session') return parsed?.state === 'settled' || parsed?.state === 'refunded';
  if (scope === 'economy_deferred_wanted') {
    return parsed?.state === 'completed' || parsed?.state === 'cancelled';
  }
  if (scope === 'blackmarket_duel') return parsed?.state === 'resolved';
  if (RAID_EFFECT_SCOPES.has(scope)) return true;
  if (scope === 'voice_reward_bucket') return true;
  return false;
}

export async function cleanupExpiredEconomyClaims(): Promise<number> {
  const db = getDatabase();
  const now = new Date();
  const candidates = await db.operationClaim.findMany({
    where: {
      scope: { in: [...ECONOMY_EXPIRING_SCOPES] },
      expiresAt: { lte: now },
    },
    orderBy: { expiresAt: 'asc' },
    take: 500,
  });

  const removable: string[] = [];
  for (const claim of candidates) {
    if (!claim.guildId || !isGuildAllowed(claim.guildId)) continue;
    if (isImmediatelyCleanableEconomyClaim(claim.scope, claim.metadata)) {
      removable.push(claim.key);
      continue;
    }

    const metadata = metadataRecord(claim.metadata);
    if (claim.scope === 'heist_membership') {
      const heistId = typeof metadata?.heistId === 'string' ? metadata.heistId : null;
      if (!heistId) continue;
      const heist = await db.economyHeist.findUnique({
        where: { id: heistId },
        select: { status: true },
      });
      if (!heist || TERMINAL_HEIST_STATES.has(heist.status)) removable.push(claim.key);
      continue;
    }

    if (claim.scope === 'blackmarket_duel') {
      const dealId = claim.key.startsWith('blackmarket-duel:')
        ? claim.key.slice('blackmarket-duel:'.length)
        : null;
      if (!dealId) continue;
      const deal = await db.blackMarketDeal.findUnique({
        where: { id: dealId },
        select: { status: true },
      });
      if (!deal || deal.status !== 'accepted') removable.push(claim.key);
    }
  }

  if (removable.length === 0) return 0;
  const removed = await db.operationClaim.deleteMany({
    where: {
      key: { in: removable },
      scope: { in: [...ECONOMY_EXPIRING_SCOPES] },
      expiresAt: { lte: now },
    },
  });
  return removed.count;
}

export function startEconomyMaintenance(): void {
  scheduleTask(TASK, INTERVAL_MS, async () => {
    const refunded = await recoverStaleBlackjackSessions();
    const removed = await cleanupExpiredEconomyClaims();
    if (refunded > 0 || removed > 0) {
      log.info(`Maintenance complete: blackjack refunds=${refunded}, claims removed=${removed}`);
    }
  }, { exclusive: true, immediate: true });
}

export function stopEconomyMaintenance(): void {
  unscheduleTask(TASK);
}
