// ═══════════════════════════════════════════════
//  RegBattle — CRUD с Redis-кэшированием
// ═══════════════════════════════════════════════

import { Prisma } from '@prisma/client';
import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import {
  getPrismaErrorCode,
  LIVE_REPRIMAND_STATUSES,
  TRANSITIONAL_REPRIMAND_STATUSES,
} from './safety';
import { firstFreeSquadNumber } from './squadNumbering';

const CACHE_PREFIX = 'rb:cfg';
const CACHE_TTL = 600; // 10 минут

// ═══════════════════════════════════════════════
//  RegBattleConfig
// ═══════════════════════════════════════════════

export async function getConfig(guildId: string) {
  const r = getRedis();
  const cached = await r.get(`${CACHE_PREFIX}:${guildId}`);
  if (cached) return JSON.parse(cached);

  const config = await getDatabase().regbattleConfig.findUnique({ where: { guildId } });
  if (config) {
    await r.setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  }
  return config;
}

export async function upsertConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().regbattleConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });

  await getRedis().setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  return config;
}

export async function deleteConfig(guildId: string) {
  await getDatabase().regbattleConfig.deleteMany({ where: { guildId } });
  await getRedis().del(`${CACHE_PREFIX}:${guildId}`);
}

// ═══════════════════════════════════════════════
//  RegBattleSquad — CRUD
// ═══════════════════════════════════════════════

/**
 * Allocate the first free per-guild number and create its row in one
 * serializable transaction. P2034/P2002 are retried because another process
 * can legitimately win the same allocation between reads.
 */
export async function createSquadWithAllocatedNumber(data: {
  guildId: string;
  voiceChannelId: string;
  ownerId: string;
  configId: string;
  airChannelId?: string;
  panelMessageId?: string;
}) {
  const database = getDatabase();
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await database.$transaction(async (tx) => {
        const existing = await tx.regbattleSquad.findMany({
          where: { guildId: data.guildId },
          select: { number: true },
          orderBy: { number: 'asc' },
        });
        const number = firstFreeSquadNumber(existing.map((row) => row.number));
        return tx.regbattleSquad.create({
          data: { ...data, number },
          include: { config: true },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const code = getPrismaErrorCode(error);
      if (attempt < maxAttempts && (code === 'P2034' || code === 'P2002')) continue;
      throw error;
    }
  }
  throw new Error('Unreachable squad allocation retry state');
}

export async function getSquad(id: string) {
  return getDatabase().regbattleSquad.findUnique({
    where: { id },
    include: { config: true },
  });
}

export async function getSquadByVoice(voiceChannelId: string) {
  return getDatabase().regbattleSquad.findUnique({
    where: { voiceChannelId },
    include: { config: true },
  });
}

/**
 * Найти отряд по основному или авиационному голосовому каналу
 */
export async function getSquadByAnyVoice(channelId: string) {
  // Сначала проверяем основной канал
  const byMain = await getDatabase().regbattleSquad.findUnique({
    where: { voiceChannelId: channelId },
    include: { config: true },
  });
  if (byMain) return byMain;

  // Проверяем авиа-канал
  return getDatabase().regbattleSquad.findFirst({
    where: { airChannelId: channelId },
    include: { config: true },
  });
}

export async function updateSquad(id: string, data: Record<string, any>) {
  return getDatabase().regbattleSquad.update({
    where: { id },
    data,
    include: { config: true },
  });
}

export async function deleteSquad(id: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // deleteMany is idempotent: a replay after a lost DB response is success.
      return await getDatabase().regbattleSquad.deleteMany({ where: { id } });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to delete squad ${id}`);
}

/**
 * Все активные отряды в гильдии
 */
export async function getGuildSquads(guildId: string) {
  return getDatabase().regbattleSquad.findMany({
    where: { guildId },
    orderBy: { number: 'asc' },
    include: { config: true },
  });
}

/**
 * Все ПБ-каналы в гильдии (voiceChannelId + airChannelId)
 */
export async function getAllPbChannelIds(guildId: string): Promise<string[]> {
  const squads = await getDatabase().regbattleSquad.findMany({
    where: { guildId },
    select: { voiceChannelId: true, airChannelId: true },
  });

  const ids: string[] = [];
  for (const s of squads) {
    ids.push(s.voiceChannelId);
    if (s.airChannelId) ids.push(s.airChannelId);
  }
  return ids;
}

// ═══════════════════════════════════════════════
//  Reprimand — CRUD (выговоры)
// ═══════════════════════════════════════════════

export async function createReprimand(data: {
  guildId: string;
  offenderId: string;
  issuerId: string;
  typeRoleId: string;
  reason: string;
  messageId?: string;
  channelId?: string;
  expiresAt?: Date | null;
  status?: string;
}) {
  return getDatabase().reprimand.create({ data });
}

export async function getReprimand(id: string) {
  return getDatabase().reprimand.findUnique({ where: { id } });
}

export async function updateReprimand(id: string, data: Record<string, any>) {
  return getDatabase().reprimand.update({ where: { id }, data });
}

/** Compare-and-set status transition. Returns false when another worker won. */
export async function updateReprimandStatusCas(
  id: string,
  expectedStatuses: string[],
  data: Record<string, any>,
): Promise<boolean> {
  const result = await getDatabase().reprimand.updateMany({
    where: { id, status: { in: expectedStatuses } },
    data,
  });
  return result.count === 1;
}

export async function deleteReprimandStatusCas(id: string, expectedStatuses: string[]): Promise<boolean> {
  const result = await getDatabase().reprimand.deleteMany({
    where: { id, status: { in: expectedStatuses } },
  });
  return result.count === 1;
}

/** Atomic expiry claim, with recovery of a worker that died while expiring. */
export async function claimReprimandForExpiry(id: string): Promise<boolean> {
  const staleClaimBefore = new Date(Date.now() - 5 * 60_000);
  const result = await getDatabase().reprimand.updateMany({
    where: {
      id,
      OR: [
        { status: { in: ['active', 'appealing', 'pending_cleanup', 'expired_ui_pending'] } },
        { status: 'expiring', updatedAt: { lte: staleClaimBefore } },
      ],
      expiresAt: { not: null, lte: new Date() },
    },
    data: { status: 'expiring' },
  });
  return result.count === 1;
}

/** Whether the same Discord role is still justified by another live record. */
export async function hasOtherLiveReprimand(
  id: string,
  guildId: string,
  offenderId: string,
  typeRoleId: string,
): Promise<boolean> {
  const count = await getDatabase().reprimand.count({
    where: {
      id: { not: id },
      guildId,
      offenderId,
      typeRoleId,
      // A shared Discord role cannot be removed while any non-terminal row may
      // still justify it. Terminal workers run a second cleanup after commit,
      // so two simultaneous transitions cannot strand the role permanently.
      status: { in: [...LIVE_REPRIMAND_STATUSES] },
    },
  });
  return count > 0;
}

export async function getTransitionalReprimands(staleBefore?: Date) {
  return getDatabase().reprimand.findMany({
    where: {
      status: { in: [...TRANSITIONAL_REPRIMAND_STATUSES] },
      ...(staleBefore ? { updatedAt: { lte: staleBefore } } : {}),
    },
    orderBy: { updatedAt: 'asc' },
  });
}

export async function getReprimandsWithPendingAppealCleanup() {
  return getDatabase().reprimand.findMany({
    where: {
      AND: [
        {
          OR: [
            { appealCategoryId: { not: null } },
            { appealTextId: { not: null } },
            { appealVoiceId: { not: null } },
          ],
        },
        {
          OR: [
            { status: { in: ['annulled', 'expired'] } },
            { status: 'active', appealDecision: 'rejected' },
          ],
        },
      ],
    },
  });
}

/**
 * Найти все активные выговоры с истёкшим сроком
 */
export async function getExpiredReprimands() {
  return getDatabase().reprimand.findMany({
    where: {
      OR: [
        { status: { in: ['active', 'appealing', 'pending_cleanup', 'expired_ui_pending'] } },
        { status: 'expiring', updatedAt: { lte: new Date(Date.now() - 5 * 60_000) } },
      ],
      expiresAt: { not: null, lte: new Date() },
    },
  });
}
