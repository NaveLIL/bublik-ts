// ═══════════════════════════════════════════════
//  RegBattle — CRUD с Redis-кэшированием
// ═══════════════════════════════════════════════

import { getDatabase } from '../../core/Database';
import { getRedis } from '../../core/Redis';

const CACHE_PREFIX = 'rb:cfg';
const CACHE_TTL = 600; // 10 минут

// ═══════════════════════════════════════════════
//  RegBattleConfig
// ═══════════════════════════════════════════════

export async function getConfig(guildId: string) {
  const r = getRedis();
  const cached = await r.get(`${CACHE_PREFIX}:${guildId}`);
  if (cached) return JSON.parse(cached);

  const config = await getDatabase().regBattleConfig.findUnique({ where: { guildId } });
  if (config) {
    await r.setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  }
  return config;
}

export async function upsertConfig(guildId: string, data: Record<string, any>) {
  const config = await getDatabase().regBattleConfig.upsert({
    where: { guildId },
    create: { guildId, ...data },
    update: data,
  });

  await getRedis().setex(`${CACHE_PREFIX}:${guildId}`, CACHE_TTL, JSON.stringify(config));
  return config;
}

export async function deleteConfig(guildId: string) {
  await getDatabase().regBattleConfig.deleteMany({ where: { guildId } });
  await getRedis().del(`${CACHE_PREFIX}:${guildId}`);
}

// ═══════════════════════════════════════════════
//  RegBattleSquad — CRUD
// ═══════════════════════════════════════════════

export async function createSquad(data: {
  guildId: string;
  number: number;
  voiceChannelId: string;
  ownerId: string;
  configId: string;
  airChannelId?: string;
  panelMessageId?: string;
}) {
  return getDatabase().regBattleSquad.create({
    data,
    include: { config: true },
  });
}

export async function getSquad(id: string) {
  return getDatabase().regBattleSquad.findUnique({
    where: { id },
    include: { config: true },
  });
}

export async function getSquadByVoice(voiceChannelId: string) {
  return getDatabase().regBattleSquad.findUnique({
    where: { voiceChannelId },
    include: { config: true },
  });
}

/**
 * Найти отряд по основному или авиационному голосовому каналу
 */
export async function getSquadByAnyVoice(channelId: string) {
  // Сначала проверяем основной канал
  const byMain = await getDatabase().regBattleSquad.findUnique({
    where: { voiceChannelId: channelId },
    include: { config: true },
  });
  if (byMain) return byMain;

  // Проверяем авиа-канал
  return getDatabase().regBattleSquad.findFirst({
    where: { airChannelId: channelId },
    include: { config: true },
  });
}

export async function updateSquad(id: string, data: Record<string, any>) {
  return getDatabase().regBattleSquad.update({
    where: { id },
    data,
    include: { config: true },
  });
}

export async function deleteSquad(id: string) {
  return getDatabase().regBattleSquad.delete({ where: { id } }).catch(() => null);
}

/**
 * Все активные отряды в гильдии
 */
export async function getGuildSquads(guildId: string) {
  return getDatabase().regBattleSquad.findMany({
    where: { guildId },
    orderBy: { number: 'asc' },
    include: { config: true },
  });
}

/**
 * Следующий номер отряда для гильдии
 */
export async function getNextSquadNumber(guildId: string): Promise<number> {
  const squads = await getDatabase().regBattleSquad.findMany({
    where: { guildId },
    select: { number: true },
    orderBy: { number: 'asc' },
  });

  // Находим первый свободный номер
  for (let i = 1; i <= squads.length + 1; i++) {
    if (!squads.some((s: { number: number }) => s.number === i)) return i;
  }
  return squads.length + 1;
}

/**
 * Все ПБ-каналы в гильдии (voiceChannelId + airChannelId)
 */
export async function getAllPbChannelIds(guildId: string): Promise<string[]> {
  const squads = await getDatabase().regBattleSquad.findMany({
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
