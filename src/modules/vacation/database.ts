// ═══════════════════════════════════════════════
//  Vacation — CRUD с Redis-кэшированием
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { Prisma } from '@prisma/client';
import { AUTO_DENY_MIN_MS, REMINDER_BEFORE_MS, VacationStatus } from './constants';
import {
  isNsTerminalStatus,
  isNsTransitionAllowed,
  isVacationTerminalStatus,
  isVacationTransitionAllowed,
  nsVacationActiveKey,
  vacationActiveKey,
} from './state';
import { withVacationRoleConfigLock } from './roleConfigLock';

const CACHE_PREFIX = 'vac:cfg';
const CACHE_TTL = 600; // 10 минут

// ═══════════════════════════════════════════════
//  VacationConfig
// ═══════════════════════════════════════════════

export async function getConfig(guildId: string) {
  const r = getRedis();
  const cached = await r.get(`${CACHE_PREFIX}:${guildId}`);
  if (cached) return JSON.parse(cached);

  const config = await getDatabase().vacationConfig.findUnique({ where: { guildId } });
  if (config) {
    await r.setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  }
  return config;
}

export async function upsertConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().vacationConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });

  await getRedis().setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  return config;
}

export async function deleteConfig(guildId: string) {
  await getDatabase().vacationConfig.deleteMany({ where: { guildId } });
  await getRedis().del(`${CACHE_PREFIX}:${guildId}`);
}

/** Configurations whose Discord vacation role must mirror durable state. */
export async function findVacationRoleConfigs() {
  return getDatabase().vacationConfig.findMany({
    where: { vacationRoleId: { not: null } },
    select: { guildId: true, vacationRoleId: true },
  });
}

// (invalidateConfigCache удалён — upsertConfig обновляет кэш автоматически)

// ═══════════════════════════════════════════════
//  VacationRequest — CRUD
// ═══════════════════════════════════════════════

export type VacationRequestCreate = {
  guildId: string;
  userId: string;
  type: string;
  reason: string;
  durationMinutes: number;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  savedRoleIds?: string[];
  configId: string;
  reviewerId?: string;
};

class RoleVacationConflictError extends Error {
  constructor() {
    super('Another role-mutating vacation is already active for this member');
    this.name = 'RoleVacationConflictError';
  }
}

const ROLE_MUTATING_NS_TYPES: string[] = ['shield', 'troll'];
const NS_LIVE_STATUSES: string[] = ['activating', 'active', 'restoring'];
const VACATION_ROLE_LIVE_STATUSES: string[] = [
  VacationStatus.Activating,
  VacationStatus.Active,
  VacationStatus.Restoring,
];

async function lockRoleMutationSlot(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<void> {
  // One PostgreSQL transaction lock arbitrates both tables. Unlike an
  // in-memory/Redis lock it cannot expire between the conflict check and write.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vacation-role:${guildId}:${userId}`}))`;
}

async function hasLiveNsRoleMutation(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<boolean> {
  return (await tx.nsVacation.count({
    where: {
      guildId,
      userId,
      type: { in: ROLE_MUTATING_NS_TYPES },
      status: { in: NS_LIVE_STATUSES },
    },
  })) > 0;
}

async function hasLiveRegularRoleMutation(
  tx: Prisma.TransactionClient,
  guildId: string,
  userId: string,
): Promise<boolean> {
  return (await tx.vacationRequest.count({
    where: { guildId, userId, status: { in: VACATION_ROLE_LIVE_STATUSES } },
  })) > 0;
}

export function isActiveKeyConflict(error: unknown): boolean {
  return error instanceof RoleVacationConflictError ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
}

export async function createRequest(data: VacationRequestCreate) {
  const status = data.status ?? VacationStatus.Pending;
  const create = (tx: Prisma.TransactionClient) => tx.vacationRequest.create({
      data: {
        ...data,
        status,
        activeKey: isVacationTerminalStatus(status)
          ? null
          : vacationActiveKey(data.guildId, data.userId),
      },
      include: { config: true },
    });
  if (!VACATION_ROLE_LIVE_STATUSES.includes(status)) return create(getDatabase());

  return withVacationRoleConfigLock(data.guildId, async (configLock) => {
    await configLock.assertOwned();
    return getDatabase().$transaction(async (tx) => {
      await lockRoleMutationSlot(tx, data.guildId, data.userId);
      if (await hasLiveNsRoleMutation(tx, data.guildId, data.userId)) {
        throw new RoleVacationConflictError();
      }
      return create(tx);
    });
  });
}

export async function getRequest(id: string) {
  return getDatabase().vacationRequest.findUnique({
    where: { id },
    include: { config: true },
  });
}

/** Authoritative role-bearing vacation for one member, if one exists. */
export async function findLiveRoleVacationForMember(guildId: string, userId: string) {
  return getDatabase().vacationRequest.findFirst({
    where: {
      guildId,
      userId,
      status: { in: [VacationStatus.Activating, VacationStatus.Active] },
    },
    include: { config: true },
  });
}

export async function findLiveRoleVacationUserIds(
  guildId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) return new Set();
  const rows = await getDatabase().vacationRequest.findMany({
    where: {
      guildId,
      userId: { in: uniqueUserIds },
      status: { in: [VacationStatus.Activating, VacationStatus.Active] },
    },
    select: { userId: true },
  });
  return new Set(rows.map(({ userId }) => userId));
}

/**
 * First activation seals exact restoration provenance before Discord changes.
 * An empty array is meaningful and is distinguished by roleSnapshotAt.
 */
export async function sealVacationRoleSnapshot(
  id: string,
  savedRoleIds: readonly string[],
) {
  const sealedAt = new Date();
  const result = await getDatabase().vacationRequest.updateMany({
    where: {
      id,
      status: VacationStatus.Activating,
      roleSnapshotAt: null,
    },
    data: {
      savedRoleIds: { set: [...savedRoleIds] },
      roleSnapshotAt: sealedAt,
    },
  });
  if (result.count !== 1) {
    const current = await getRequest(id);
    if (!current?.roleSnapshotAt) {
      throw new Error(`Vacation ${id} role snapshot could not be sealed`);
    }
    return current;
  }
  const sealed = await getRequest(id);
  if (!sealed?.roleSnapshotAt) {
    throw new Error(`Vacation ${id} role snapshot seal was not durable`);
  }
  return sealed;
}

export async function updateRequest(id: string, data: Record<string, any>) {
  if (typeof data.status === 'string') {
    throw new Error('Status changes must use transitionRequest()');
  }
  return getDatabase().vacationRequest.update({
    where: { id },
    data,
    include: { config: true },
  });
}

/** Compare-and-swap transition. Terminal states always release the unique active slot. */
export async function transitionRequest(
  id: string,
  expectedStatus: string | readonly string[],
  data: Record<string, any>,
  expectedUpdatedAt?: Date,
) {
  const statuses = Array.isArray(expectedStatus) ? [...expectedStatus] : [expectedStatus];
  const nextStatus = typeof data.status === 'string' ? data.status : undefined;
  if (nextStatus && statuses.some((status) => !isVacationTransitionAllowed(status, nextStatus))) {
    throw new Error(`Invalid vacation transition ${statuses.join('|')} -> ${nextStatus}`);
  }
  const transitionData = {
    ...data,
    ...(nextStatus && isVacationTerminalStatus(nextStatus) ? { activeKey: null } : {}),
  };
  const performTransition = () => getDatabase().$transaction(async (tx) => {
    if (nextStatus === VacationStatus.Activating) {
      const current = await tx.vacationRequest.findUnique({ where: { id } });
      if (!current || !statuses.includes(current.status)) return null;
      await lockRoleMutationSlot(tx, current.guildId, current.userId);
      if (await hasLiveNsRoleMutation(tx, current.guildId, current.userId)) return null;
    }
    const result = await tx.vacationRequest.updateMany({
      where: {
        id,
        status: { in: statuses },
        ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
      },
      data: transitionData,
    });
    if (result.count !== 1) return null;
    return tx.vacationRequest.findUnique({ where: { id }, include: { config: true } });
  });
  if (nextStatus !== VacationStatus.Activating) return performTransition();

  // Resolve only the guild scope before taking the distributed config lock.
  // The transaction above repeats every status check after the lock is owned.
  const candidate = await getDatabase().vacationRequest.findUnique({
    where: { id },
    select: { guildId: true, status: true },
  });
  if (!candidate || !statuses.includes(candidate.status)) return null;
  return withVacationRoleConfigLock(candidate.guildId, async (configLock) => {
    await configLock.assertOwned();
    return performTransition();
  });
}

/**
 * Admin force either atomically converts an existing pending request or creates
 * a new activating request. A unique activeKey arbitrates competing processes.
 */
export async function reserveForcedVacation(data: VacationRequestCreate) {
  const db = getDatabase();
  const key = vacationActiveKey(data.guildId, data.userId);
  try {
    return await withVacationRoleConfigLock(data.guildId, async (configLock) => {
      await configLock.assertOwned();
      return db.$transaction(async (tx) => {
        await lockRoleMutationSlot(tx, data.guildId, data.userId);
        if (await hasLiveNsRoleMutation(tx, data.guildId, data.userId)) return null;
        const existing = await tx.vacationRequest.findUnique({ where: { activeKey: key } });
        if (existing) {
          if (existing.status !== VacationStatus.Pending) return null;
          const changed = await tx.vacationRequest.updateMany({
            where: { id: existing.id, status: VacationStatus.Pending, activeKey: key },
            data: { ...data, status: VacationStatus.Activating, activeKey: key },
          });
          if (changed.count !== 1) return null;
          return tx.vacationRequest.findUnique({
            where: { id: existing.id },
            include: { config: true },
          });
        }

        return tx.vacationRequest.create({
          data: { ...data, status: VacationStatus.Activating, activeKey: key },
          include: { config: true },
        });
      });
    });
  } catch (error) {
    if (isActiveKeyConflict(error)) return null;
    throw error;
  }
}

export async function claimReminder(id: string): Promise<boolean> {
  const result = await getDatabase().vacationRequest.updateMany({
    where: { id, status: VacationStatus.Active, reminderSent: false },
    data: { reminderSent: true },
  });
  return result.count === 1;
}

export async function releaseReminder(id: string): Promise<void> {
  await getDatabase().vacationRequest.updateMany({
    where: { id, status: VacationStatus.Active, reminderSent: true },
    data: { reminderSent: false },
  });
}

/**
 * Найти активный отпуск пользователя в гильдии
 */
export async function getActiveVacation(guildId: string, userId: string) {
  return getDatabase().vacationRequest.findFirst({
    where: {
      guildId,
      userId,
      status: {
        in: [VacationStatus.Activating, VacationStatus.Active, VacationStatus.Restoring],
      },
    },
    include: { config: true },
  });
}

/**
 * Найти ожидающую заявку пользователя
 */
export async function getPendingRequest(guildId: string, userId: string) {
  return getDatabase().vacationRequest.findFirst({
    where: {
      guildId,
      userId,
      status: VacationStatus.Pending,
    },
  });
}

// ═══════════════════════════════════════════════
//  Запросы для шедулера
// ═══════════════════════════════════════════════

/**
 * Заявки в статусе pending старше минимального порога (1ч).
 * Реальный порог автоотклонения определяется per-guild полем config.autoDenyHours.
 */
export async function findPendingExpired() {
  const cutoff = new Date(Date.now() - AUTO_DENY_MIN_MS);
  return getDatabase().vacationRequest.findMany({
    where: {
      status: VacationStatus.Pending,
      createdAt: { lt: cutoff },
    },
    include: { config: true },
  });
}

/**
 * Активные отпуска, заканчивающиеся в течение 24ч, без отправленного напоминания
 */
export async function findActiveNeedingReminder() {
  const cutoff = new Date(Date.now() + REMINDER_BEFORE_MS);
  return getDatabase().vacationRequest.findMany({
    where: {
      status: VacationStatus.Active,
      reminderSent: false,
      endDate: { lte: cutoff, gt: new Date() },
    },
    include: { config: true },
  });
}

/**
 * Активные отпуска, время которых истекло
 */
export async function findActiveEnded() {
  const staleRestore = new Date(Date.now() - 2 * 60 * 1000);
  return getDatabase().vacationRequest.findMany({
    where: {
      OR: [
        { status: VacationStatus.Active, endDate: { lte: new Date() } },
        { status: VacationStatus.Restoring, updatedAt: { lte: staleRestore } },
      ],
    },
    include: { config: true },
  });
}

export async function findStaleActivating() {
  return getDatabase().vacationRequest.findMany({
    where: {
      status: VacationStatus.Activating,
      updatedAt: { lte: new Date(Date.now() - 2 * 60 * 1000) },
    },
    include: { config: true },
  });
}

/** Live rows are periodically reconciled so pre-hardening vacations are safe. */
export async function findLiveRoleVacations() {
  return getDatabase().vacationRequest.findMany({
    where: { status: { in: [VacationStatus.Activating, VacationStatus.Active] } },
    include: { config: true },
  });
}

/**
 * Все активные отпуска в гильдии
 */
export async function getGuildActiveVacations(guildId: string) {
  return getDatabase().vacationRequest.findMany({
    where: {
      guildId,
      status: {
        in: [
          VacationStatus.Pending,
          VacationStatus.Activating,
          VacationStatus.Active,
          VacationStatus.Restoring,
        ],
      },
    },
    orderBy: { createdAt: 'desc' },
    include: { config: true },
  });
}

// ═══════════════════════════════════════════════
//  Антиабьюз запросы
// ═══════════════════════════════════════════════

/**
 * Дата окончания последнего завершённого отпуска пользователя
 */
export async function getLastCompletedVacationEnd(guildId: string, userId: string): Promise<Date | null> {
  const last = await getDatabase().vacationRequest.findFirst({
    where: {
      guildId,
      userId,
      status: VacationStatus.Completed,
      endDate: { not: null },
    },
    orderBy: { endDate: 'desc' },
    select: { endDate: true },
  });
  return last?.endDate ?? null;
}

/**
 * Количество отпусков пользователя (active/completed) за последние N дней
 */
export async function countRecentVacations(
  guildId: string,
  userId: string,
  daysBack: number,
): Promise<number> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return getDatabase().vacationRequest.count({
    where: {
      guildId,
      userId,
      status: { in: [VacationStatus.Active, VacationStatus.Completed] },
      createdAt: { gte: since },
    },
  });
}

/**
 * Количество быстрых отпусков за последние N дней
 */
export async function countRecentQuickLeaves(
  guildId: string,
  userId: string,
  daysBack: number,
): Promise<number> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return getDatabase().vacationRequest.count({
    where: {
      guildId,
      userId,
      type: 'quick',
      status: { in: [VacationStatus.Active, VacationStatus.Completed] },
      createdAt: { gte: since },
    },
  });
}

/**
 * Получить статистику отпусков пользователя для ревью
 */
export async function getUserVacationStats(guildId: string, userId: string) {
  const [totalAll, last30d, quickLast7d, lastEnd] = await Promise.all([
    getDatabase().vacationRequest.count({
      where: { guildId, userId, status: { in: [VacationStatus.Active, VacationStatus.Completed] } },
    }),
    countRecentVacations(guildId, userId, 30),
    countRecentQuickLeaves(guildId, userId, 7),
    getLastCompletedVacationEnd(guildId, userId),
  ]);

  return { totalAll, last30d, quickLast7d, lastEnd };
}

// ═══════════════════════════════════════════════
//  Небесные Стражи — CRUD
// ═══════════════════════════════════════════════

export async function createNsVacation(data: {
  guildId: string;
  userId: string;
  type: string;
  savedRoleIds?: string[];
  reason?: string;
  messageId?: string;
  endDate: Date;
  status?: string;
}) {
  const status = data.status ?? 'active';
  const create = (tx: Prisma.TransactionClient) => tx.nsVacation.create({
      data: {
        ...data,
        status,
        activeKey: isNsTerminalStatus(status)
          ? null
          : nsVacationActiveKey(data.guildId, data.userId, data.type),
      },
    });
  const mutatesRoles = ROLE_MUTATING_NS_TYPES.includes(data.type) && !isNsTerminalStatus(status);
  if (!mutatesRoles) return create(getDatabase());

  return withVacationRoleConfigLock(data.guildId, async (configLock) => {
    return getDatabase().$transaction(async (tx) => {
      await configLock.assertOwned();
      await lockRoleMutationSlot(tx, data.guildId, data.userId);
      if (
        await hasLiveRegularRoleMutation(tx, data.guildId, data.userId) ||
        await hasLiveNsRoleMutation(tx, data.guildId, data.userId)
      ) {
        throw new RoleVacationConflictError();
      }
      await configLock.assertOwned();
      return create(tx);
    });
  });
}

export async function getActiveNsRecord(guildId: string, userId: string, type?: string) {
  const where: any = { guildId, userId, status: { in: ['activating', 'active', 'restoring'] } };
  if (type) where.type = type;
  return getDatabase().nsVacation.findFirst({ where });
}

export async function getNsVacation(id: string) {
  return getDatabase().nsVacation.findUnique({ where: { id } });
}

export async function appendLiveNsVacationSavedRole(id: string, roleId: string) {
  await getDatabase().nsVacation.updateMany({
    where: {
      id,
      status: { in: ['activating', 'active'] },
      NOT: { savedRoleIds: { has: roleId } },
    },
    data: { savedRoleIds: { push: roleId } },
  });
  return getNsVacation(id);
}

export async function updateNsVacation(id: string, data: Record<string, any>) {
  if (typeof data.status === 'string') {
    throw new Error('Status changes must use transitionNsVacation()');
  }
  return getDatabase().nsVacation.update({ where: { id }, data });
}

export async function transitionNsVacation(
  id: string,
  expectedStatus: string | readonly string[],
  data: Record<string, any>,
  expectedUpdatedAt?: Date,
) {
  const statuses = Array.isArray(expectedStatus) ? [...expectedStatus] : [expectedStatus];
  const nextStatus = typeof data.status === 'string' ? data.status : undefined;
  if (nextStatus && statuses.some((status) => !isNsTransitionAllowed(status, nextStatus))) {
    throw new Error(`Invalid NS vacation transition ${statuses.join('|')} -> ${nextStatus}`);
  }
  const result = await getDatabase().nsVacation.updateMany({
    where: {
      id,
      status: { in: statuses },
      ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
    },
    data: {
      ...data,
      ...(nextStatus && isNsTerminalStatus(nextStatus) ? { activeKey: null } : {}),
    },
  });
  if (result.count !== 1) return null;
  return getDatabase().nsVacation.findUnique({ where: { id } });
}

export async function findNsActiveEnded() {
  const stale = new Date(Date.now() - 2 * 60 * 1000);
  return getDatabase().nsVacation.findMany({
    where: {
      OR: [
        { status: 'active', endDate: { lte: new Date() } },
        { status: 'restoring', updatedAt: { lte: stale } },
      ],
    },
  });
}

export async function findStaleNsActivating() {
  return getDatabase().nsVacation.findMany({
    where: {
      status: 'activating',
      updatedAt: { lte: new Date(Date.now() - 2 * 60 * 1000) },
    },
  });
}
