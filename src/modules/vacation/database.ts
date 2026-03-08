// ═══════════════════════════════════════════════
//  Vacation — CRUD с Redis-кэшированием
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';
import { AUTO_DENY_MS, REMINDER_BEFORE_MS, VacationStatus } from './constants';

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

function invalidateConfigCache(guildId: string) {
  return getRedis().del(`${CACHE_PREFIX}:${guildId}`);
}

// ═══════════════════════════════════════════════
//  VacationRequest — CRUD
// ═══════════════════════════════════════════════

export async function createRequest(data: {
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
}) {
  return getDatabase().vacationRequest.create({ data });
}

export async function getRequest(id: string) {
  return getDatabase().vacationRequest.findUnique({
    where: { id },
    include: { config: true },
  });
}

export async function updateRequest(id: string, data: Record<string, any>) {
  return getDatabase().vacationRequest.update({
    where: { id },
    data,
    include: { config: true },
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
      status: VacationStatus.Active,
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
 * Заявки в статусе pending старше 3 часов → автоотклонение
 */
export async function findPendingExpired() {
  const cutoff = new Date(Date.now() - AUTO_DENY_MS);
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
  return getDatabase().vacationRequest.findMany({
    where: {
      status: VacationStatus.Active,
      endDate: { lte: new Date() },
    },
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
      status: { in: [VacationStatus.Active, VacationStatus.Pending] },
    },
    orderBy: { createdAt: 'desc' },
    include: { config: true },
  });
}
