// ═══════════════════════════════════════════════
//  Economy — Голосовой заработок (пассивный доход)
//
//  Начисления каждые 10 мин за присутствие в войсе.
//  Anti-AFK:
//    • мин. 2 человека в канале
//    • нельзя быть server-muted + server-deafened
//    • непрерывное присутствие ≥ 10 минут
//
//  Ставки:
//    • обычный войс: voiceRateBase ₪/ч
//    • ПБ-войс:     voiceRatePb ₪/ч
//    • + PB-множитель
// ═══════════════════════════════════════════════

import { VoiceState, Client, GuildMember, VoiceChannel, StageChannel } from 'discord.js';
import { getRedis } from '../../core/Redis';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { getDatabase } from '../../core/Database';
import { getOrCreateProfile, createTransaction, invalidateProfileCache, getEcoConfig } from './database';
import { getPbTier, addToWallet, fmt } from './profile';
import {
  REDIS_ECO_VOICE,
  VOICE_TICK_INTERVAL_MS,
  VOICE_MIN_MEMBERS,
  DEFAULTS,
  TX,
  CURRENCY,
} from './constants';

// Импорт ПБ-канальных ID для проверки ПБ-войсов
import { getAllPbChannelIds } from '../regbattle/database';

const log = logger.child('Economy:voice');

/** Глобальный интервал тикера */
let tickerInterval: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════
//  Voice state tracking (join/leave)
// ═══════════════════════════════════════════════

/**
 * Обработка voiceStateUpdate.
 * Записываем время входа в войс → Redis.
 * При выходе — НЕ начисляем (начисление — по тикеру).
 */
export async function handleVoiceUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const userId = newState.member?.id ?? oldState.member?.id;
  const guildId = newState.guild.id;
  if (!userId) return;

  const r = getRedis();
  const key = `${REDIS_ECO_VOICE}:${guildId}:${userId}`;

  const joinedChannel = newState.channelId;
  const leftChannel = oldState.channelId;

  if (!leftChannel && joinedChannel) {
    // Вошёл в войс — записываем время
    await r.set(key, Date.now().toString());
  } else if (leftChannel && !joinedChannel) {
    // Вышел из войса — удаляем трекер
    await r.del(key);
  } else if (leftChannel && joinedChannel && leftChannel !== joinedChannel) {
    // Перешёл в другой канал — обновляем время (сбрасываем таймер anti-hop)
    await r.set(key, Date.now().toString());
  }
}

// ═══════════════════════════════════════════════
//  Периодический тикер (каждые 10 мин)
// ═══════════════════════════════════════════════

/**
 * Запустить тикер голосового заработка.
 */
export function startVoiceTicker(client: Client): void {
  if (tickerInterval) return;

  tickerInterval = setInterval(async () => {
    try {
      await tickVoiceEarnings(client);
    } catch (err) {
      log.error('Ошибка тикера голосового заработка', err);
      errorReporter.eventError(err as Error, 'economy:voiceTick', 'economy');
    }
  }, VOICE_TICK_INTERVAL_MS);

  log.info(`Тикер голосового заработка запущен (интервал: ${VOICE_TICK_INTERVAL_MS / 1000}с)`);
}

/** Остановить тикер */
export function stopVoiceTicker(): void {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
    log.info('Тикер голосового заработка остановлен');
  }
}

/**
 * Один тик: обходим все гильдии → все войс-каналы → начисляем.
 */
async function tickVoiceEarnings(client: Client): Promise<void> {
  const r = getRedis();
  const now = Date.now();

  for (const [, guild] of client.guilds.cache) {
    // Проверяем, включена ли экономика в гильдии
    const config = await getEcoConfig(guild.id);
    if (!config?.enabled) continue;

    const rateBase = config.voiceRateBase ?? DEFAULTS.voiceRateBase;
    const ratePb = config.voiceRatePb ?? DEFAULTS.voiceRatePb;
    const minMembers = config.voiceMinMembers ?? VOICE_MIN_MEMBERS;

    // Получаем ПБ-каналы
    let pbChannelIds: string[] = [];
    try {
      pbChannelIds = await getAllPbChannelIds(guild.id);
    } catch {
      // Если модуль ПБ не настроен — не ошибка
    }

    // Обходим голосовые каналы
    for (const [, channel] of guild.channels.cache) {
      if (!channel.isVoiceBased()) continue;
      const vc = channel as VoiceChannel | StageChannel;

      // Получаем НЕ-бот участников
      const humans = vc.members.filter((m) => !m.user.bot);
      if (humans.size < minMembers) continue;

      const isPbChannel = pbChannelIds.includes(vc.id);
      const hourlyRate = isPbChannel ? ratePb : rateBase;
      // За 10-минутный тик — 1/6 часовой ставки
      const tickAmount = Math.floor(hourlyRate / 6);

      if (tickAmount <= 0) continue;

      for (const [memberId, member] of humans) {
        try {
          await processVoiceMember(guild.id, member, tickAmount, isPbChannel, r, now);
        } catch (err) {
          log.error(`Voice tick error for ${memberId} in ${guild.id}`, err);
        }
      }
    }
  }
}

/**
 * Начислить пассивный доход одному участнику.
 * Anti-AFK checks:
 *   1. Не server-muted + server-deafened одновременно
 *   2. В канале ≥ 10 минут (Redis joinTime)
 */
async function processVoiceMember(
  guildId: string,
  member: GuildMember,
  baseTickAmount: number,
  isPbChannel: boolean,
  redis: ReturnType<typeof getRedis>,
  now: number,
): Promise<void> {
  const userId = member.id;

  // AFK-check: server-muted AND server-deafened → не начисляем
  const voice = member.voice;
  if (voice.serverMute && voice.serverDeaf) return;

  // Self-mute + self-deaf → AFK-check (оба одновременно)
  if (voice.selfMute && voice.selfDeaf) return;

  // Проверка непрерывного присутствия (≥ 10 мин)
  const key = `${REDIS_ECO_VOICE}:${guildId}:${userId}`;
  const joinTimeStr = await redis.get(key);
  if (!joinTimeStr) {
    // Нет записи — сохраняем текущее время и пропускаем этот тик
    await redis.set(key, now.toString());
    return;
  }

  const joinTime = parseInt(joinTimeStr, 10);
  const presence = now - joinTime;
  if (presence < VOICE_TICK_INTERVAL_MS) {
    // Меньше 10 минут в канале — пропускаем
    return;
  }

  // PB-множитель для голосового заработка
  // Ставка уже учтена через rateBase/ratePb; множитель по PB-тиру будет добавлен
  // когда pbRoleIds появится в EconomyConfig (TODO: Phase 2)
  const multiplier = 1;

  const finalAmount = Math.floor(baseTickAmount * multiplier);
  if (finalAmount <= 0) return;

  // Начисляем атомарно через { increment } (безопасно без лока)
  const profile = await getOrCreateProfile(guildId, userId);
  const db = getDatabase();

  const updated = await db.economyProfile.update({
    where: { guildId_userId: { guildId, userId } },
    data: {
      wallet: { increment: finalAmount },
      totalEarned: { increment: BigInt(finalAmount) },
    },
  });

  await createTransaction({
    guildId,
    userId,
    type: TX.EARN_VOICE,
    amount: finalAmount,
    balance: updated.wallet,
    profileId: profile.id,
    details: isPbChannel ? 'ПБ-войс' : 'Обычный войс',
  });

  await invalidateProfileCache(guildId, userId);
}

// ═══════════════════════════════════════════════
//  Cleanup: удалить все voice-трекеры при выгрузке
// ═══════════════════════════════════════════════

export async function cleanupVoiceTrackers(): Promise<void> {
  try {
    const r = getRedis();
    const pattern = `${REDIS_ECO_VOICE}:*`;
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await r.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    if (totalDeleted > 0) {
      log.info(`Очищено ${totalDeleted} voice-трекеров`);
    }
  } catch (err) {
    log.error('Ошибка очистки voice-трекеров', err);
  }
}
