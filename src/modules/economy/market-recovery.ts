import { Client } from 'discord.js';
import { getDatabase } from '../../core/Database';
import { logger } from '../../core/Logger';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';

const TASK = 'economy:marketApprovalRecovery';
const INTERVAL_MS = 60_000;
export const MARKET_APPROVAL_LEASE_MS = 5 * 60_000;
const UNKNOWN_ROLE_CODE = 10_011;

const log = logger.child('Economy:MarketRecovery');

function isUnknownRoleError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return Number((error as { code?: unknown }).code) === UNKNOWN_ROLE_CODE;
}

async function resetApproval(requestId: string, createdRoleId: string | null): Promise<boolean> {
  const updated = await getDatabase().shopRoleRequest.updateMany({
    where: {
      id: requestId,
      status: 'approving',
      createdRoleId,
    },
    data: {
      status: 'pending',
      reviewerId: null,
      reviewNote: null,
      reviewedAt: null,
      createdRoleId: null,
      itemId: null,
    },
  });
  return updated.count === 1;
}

/**
 * Finish or release marketplace approvals whose worker disappeared. Only guilds
 * currently owned by this Discord client are eligible for external mutations.
 */
export async function recoverStaleMarketApprovals(client: Client): Promise<number> {
  const guildIds = [...client.guilds.cache.keys()].filter(isGuildAllowed);
  if (guildIds.length === 0) return 0;

  const db = getDatabase();
  const staleBefore = new Date(Date.now() - MARKET_APPROVAL_LEASE_MS);
  const requests = await db.shopRoleRequest.findMany({
    where: {
      guildId: { in: guildIds },
      status: 'approving',
      OR: [{ reviewedAt: null }, { reviewedAt: { lte: staleBefore } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  let recovered = 0;
  for (const request of requests) {
    try {
      const guild = client.guilds.cache.get(request.guildId);
      if (!guild || !isGuildAllowed(request.guildId)) continue;

      if (!request.createdRoleId) {
        if (await resetApproval(request.id, null)) recovered++;
        continue;
      }

      let role = guild.roles.cache.get(request.createdRoleId) ?? null;
      if (!role) {
        try {
          role = await guild.roles.fetch(request.createdRoleId);
        } catch (error) {
          if (!isUnknownRoleError(error)) throw error;
          role = null;
        }
      }

      if (!role) {
        if (await resetApproval(request.id, request.createdRoleId)) recovered++;
        continue;
      }

      const config = await db.economyConfig.findUnique({
        where: { guildId: request.guildId },
        select: { id: true },
      });
      if (!config) {
        await role.delete('rollback: economy config missing during marketplace recovery');
        if (await resetApproval(request.id, request.createdRoleId)) recovered++;
        continue;
      }

      const item = await db.$transaction(async (tx) => {
        const recoveredItem = await tx.shopItem.upsert({
          where: {
            guildId_roleId: {
              guildId: request.guildId,
              roleId: request.createdRoleId!,
            },
          },
          create: {
            guildId: request.guildId,
            roleId: request.createdRoleId!,
            name: request.name,
            description: request.description,
            price: request.proposedPrice,
            durationHours: request.durationHours,
            configId: config.id,
            perks: request.perks ?? undefined,
            sellerId: request.sellerId,
            commissionPct: request.commissionPct,
          },
          update: {},
        });
        const finalized = await tx.shopRoleRequest.updateMany({
          where: {
            id: request.id,
            status: 'approving',
            createdRoleId: request.createdRoleId,
          },
          data: {
            status: 'approved',
            itemId: recoveredItem.id,
            reviewedAt: new Date(),
          },
        });
        if (finalized.count !== 1) throw new Error('market_approval_claim_lost');
        return recoveredItem;
      });

      recovered++;
      log.info(`[${request.guildId}] recovered marketplace request ${request.id} -> item ${item.id}`);
    } catch (error) {
      log.error(`Marketplace approval recovery failed for ${request.id}; it will be retried`, error);
    }
  }
  return recovered;
}

export function startMarketRecovery(client: Client): void {
  scheduleTask(TASK, INTERVAL_MS, async () => {
    const recovered = await recoverStaleMarketApprovals(client);
    if (recovered > 0) log.info(`Recovered ${recovered} stale marketplace approval(s)`);
  }, { exclusive: true, immediate: true });
}

export function stopMarketRecovery(): void {
  unscheduleTask(TASK);
}
