// ═══════════════════════════════════════════════
//  TempVoice — работа с базой данных
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { cacheGet, cacheSet, cacheDel } from '../../core/Redis';
import { logger } from '../../core/Logger';
import type {
  TempVoiceGenerator,
  TempVoiceChannel,
  TempVoiceUserSettings,
} from '@prisma/client';

const log = logger.child('TempVoice:DB');
const CACHE_TTL = 600; // 10 минут

// ═══════════════════════════════════════════════
//  Генераторы
// ═══════════════════════════════════════════════

/** Получить генератор по ID голосового канала */
export async function getGenerator(channelId: string): Promise<TempVoiceGenerator | null> {
  const cacheKey = `tv:gen:${channelId}`;
  const cached = await cacheGet<TempVoiceGenerator>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const gen = await db.tempVoiceGenerator.findUnique({
    where: { channelId },
  });

  if (gen) await cacheSet(cacheKey, gen, CACHE_TTL);
  return gen;
}

/** Получить генератор по внутреннему ID (cuid) */
export async function getGeneratorById(id: string): Promise<TempVoiceGenerator | null> {
  const cacheKey = `tv:gen:id:${id}`;
  const cached = await cacheGet<TempVoiceGenerator>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const gen = await db.tempVoiceGenerator.findUnique({
    where: { id },
  });

  if (gen) await cacheSet(cacheKey, gen, CACHE_TTL);
  return gen;
}

/** Получить все генераторы гильдии */
export async function getGuildGenerators(guildId: string): Promise<TempVoiceGenerator[]> {
  const db = getDatabase();
  return db.tempVoiceGenerator.findMany({ where: { guildId } });
}

/** Создать генератор */
export async function createGenerator(data: {
  guildId: string;
  channelId: string;
  categoryId: string;
  defaultName?: string;
  immuneRoleIds?: string[];
}): Promise<TempVoiceGenerator> {
  const db = getDatabase();
  const gen = await db.tempVoiceGenerator.create({ data });
  await cacheSet(`tv:gen:${data.channelId}`, gen, CACHE_TTL);
  return gen;
}

/** Обновить генератор */
export async function updateGenerator(
  channelId: string,
  data: Partial<Omit<TempVoiceGenerator, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<TempVoiceGenerator> {
  const db = getDatabase();
  const gen = await db.tempVoiceGenerator.update({
    where: { channelId },
    data,
  });
  await cacheSet(`tv:gen:${channelId}`, gen, CACHE_TTL);
  // Инвалидировать кэш по ID тоже
  await cacheDel(`tv:gen:id:${gen.id}`);
  return gen;
}

/** Удалить генератор */
export async function deleteGenerator(channelId: string): Promise<void> {
  const db = getDatabase();
  const gen = await db.tempVoiceGenerator.findUnique({ where: { channelId } });
  await db.tempVoiceGenerator.delete({ where: { channelId } }).catch(() => null);
  await cacheDel(`tv:gen:${channelId}`);
  if (gen) await cacheDel(`tv:gen:id:${gen.id}`);
}

// ═══════════════════════════════════════════════
//  Активные каналы
// ═══════════════════════════════════════════════

/** Получить канал по ID */
export async function getChannel(channelId: string): Promise<TempVoiceChannel | null> {
  const cacheKey = `tv:ch:${channelId}`;
  const cached = await cacheGet<TempVoiceChannel>(cacheKey);
  if (cached) return cached;

  const db = getDatabase();
  const ch = await db.tempVoiceChannel.findUnique({
    where: { id: channelId },
  });

  if (ch) await cacheSet(cacheKey, ch, CACHE_TTL);
  return ch;
}

/** Получить все каналы пользователя */
export async function getUserChannels(ownerId: string, guildId: string): Promise<TempVoiceChannel[]> {
  const db = getDatabase();
  return db.tempVoiceChannel.findMany({ where: { ownerId, guildId } });
}

/** Создать запись канала */
export async function createChannel(data: {
  id: string;
  guildId: string;
  ownerId: string;
  generatorId: string;
  state?: string;
}): Promise<TempVoiceChannel> {
  const db = getDatabase();
  const ch = await db.tempVoiceChannel.create({ data });
  await cacheSet(`tv:ch:${data.id}`, ch, CACHE_TTL);
  return ch;
}

/** Обновить канал */
export async function updateChannel(
  channelId: string,
  data: Partial<Omit<TempVoiceChannel, 'id' | 'createdAt'>>,
): Promise<TempVoiceChannel> {
  const db = getDatabase();
  const ch = await db.tempVoiceChannel.update({
    where: { id: channelId },
    data: { ...data, lastActivity: new Date() },
  });
  await cacheSet(`tv:ch:${channelId}`, ch, CACHE_TTL);
  return ch;
}

/** Удалить запись канала */
export async function deleteChannel(channelId: string): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceChannel.delete({ where: { id: channelId } }).catch(() => null);
  await cacheDel(`tv:ch:${channelId}`);
}

/** Получить все активные каналы гильдии */
export async function getGuildChannels(guildId: string): Promise<TempVoiceChannel[]> {
  const db = getDatabase();
  return db.tempVoiceChannel.findMany({ where: { guildId } });
}

/** Получить все неактивные каналы (старше maxAge мс) */
export async function getInactiveChannels(maxAgeMs: number): Promise<TempVoiceChannel[]> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs);
  return db.tempVoiceChannel.findMany({
    where: { lastActivity: { lt: cutoff } },
  });
}

// ═══════════════════════════════════════════════
//  Доверенные / заблокированные
// ═══════════════════════════════════════════════

/** Добавить доверенного пользователя */
export async function addTrusted(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceTrust.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId },
    update: {},
  });
}

/** Удалить доверенного пользователя */
export async function removeTrusted(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceTrust.deleteMany({ where: { channelId, userId } });
}

/** Получить список доверенных */
export async function getTrusted(channelId: string): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.tempVoiceTrust.findMany({
    where: { channelId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Добавить в блок-лист */
export async function addBlocked(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceBlock.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId },
    update: {},
  });
}

/** Убрать из блок-листа */
export async function removeBlocked(channelId: string, userId: string): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceBlock.deleteMany({ where: { channelId, userId } });
}

/** Получить список заблокированных */
export async function getBlocked(channelId: string): Promise<string[]> {
  const db = getDatabase();
  const rows = await db.tempVoiceBlock.findMany({
    where: { channelId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ═══════════════════════════════════════════════
//  Пользовательские настройки
// ═══════════════════════════════════════════════

/** Получить сохранённые настройки пользователя */
export async function getUserSettings(
  userId: string,
  guildId: string,
): Promise<TempVoiceUserSettings | null> {
  const db = getDatabase();
  return db.tempVoiceUserSettings.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
}

/** Сохранить настройки пользователя */
export async function saveUserSettings(
  userId: string,
  guildId: string,
  data: { savedName?: string; savedLimit?: number; savedBitrate?: number; savedRegion?: string },
): Promise<void> {
  const db = getDatabase();
  await db.tempVoiceUserSettings.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: { userId, guildId, ...data },
    update: data,
  });
}
