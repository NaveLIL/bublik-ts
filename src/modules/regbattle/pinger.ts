// ═══════════════════════════════════════════════
//  RegBattle — Система автоматических пингов
//
//  Стейт-машина на гильдию:
//  1. IDLE       — нет активных отрядов
//  2. RECRUITING — пинг роли каждые 5 мин
//  3. ESCALATED  — именные пинги каждые 30 сек
//  4. FULL       — все отряды полны → предложение
//                  перейти в запасные каждые 15 мин
//
//  Один setInterval (10 сек) проверяет все гильдии.
//  Состояние в памяти → пересчитывается при рестарте.
// ═══════════════════════════════════════════════

import { Guild, GuildMember, VoiceChannel, ChannelType, TextChannel } from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

import {
  PINGER_INTERVAL_MS,
  ROLE_PING_INTERVAL_MS,
  INDIVIDUAL_PING_INTERVAL_MS,
  FULL_SUGGEST_INTERVAL_MS,
} from './constants';

import { getConfig, getGuildSquads, getAllPbChannelIds } from './database';
import { getSquadMemberCount } from './utils';

import {
  buildRecruitPingEmbed,
  buildFullSuggestEmbed,
  buildIndividualPingMessage,
} from './embeds';

const log = logger.child('RegBattle:Pinger');

// ═══════════════════════════════════════════════
//  Типы
// ═══════════════════════════════════════════════

enum PingPhase {
  Idle = 'idle',
  Recruiting = 'recruiting',
  Escalated = 'escalated',
  Full = 'full',
}

interface GuildPingerState {
  phase: PingPhase;
  lastRolePingAt: number;
  lastIndividualPingAt: number;
  lastFullSuggestAt: number;
  lastEscalationEndedAt: number; // когда закончился последний цикл именных пингов
  rolePingsWithoutProgress: number;
  lastKnownTotal: number;
  individualQueue: string[];     // userIds для именного пинга
  individualIndex: number;
  dirty: boolean;                // требуется пересчёт
}

// ═══════════════════════════════════════════════
//  Глобальное состояние
// ═══════════════════════════════════════════════

const guildStates = new Map<string, GuildPingerState>();
let pingerInterval: ReturnType<typeof setInterval> | null = null;
let pingerClient: BublikClient | null = null;
let isRunning = false;

// ═══════════════════════════════════════════════
//  Start / Stop
// ═══════════════════════════════════════════════

export function startPinger(client: BublikClient): void {
  if (pingerInterval) return;
  pingerClient = client;

  pingerInterval = setInterval(() => {
    runPingerCycle().catch((err) => {
      log.error('Ошибка пингера', { error: String(err) });
      errorReporter.eventError(err, 'regbattlePinger', 'regbattle');
    });
  }, PINGER_INTERVAL_MS);

  log.info('Пингер ПБ запущен (интервал 10с)');
}

export function stopPinger(): void {
  if (pingerInterval) {
    clearInterval(pingerInterval);
    pingerInterval = null;
    pingerClient = null;
    guildStates.clear();
    log.info('Пингер ПБ остановлен');
  }
}

/**
 * Вызывается из lifecycle при изменении состава отрядов.
 * Ставит флаг «dirty» чтобы при следующем тике пересчитать фазу.
 */
export function recalculatePinger(guildId: string): void {
  const state = guildStates.get(guildId);
  if (state) {
    state.dirty = true;
  } else {
    // Создаём новый стейт — будет инициализирован на следующем тике
    guildStates.set(guildId, createEmptyState());
  }
}

function createEmptyState(): GuildPingerState {
  return {
    phase: PingPhase.Idle,
    lastRolePingAt: 0,
    lastIndividualPingAt: 0,
    lastFullSuggestAt: 0,
    lastEscalationEndedAt: 0,
    rolePingsWithoutProgress: 0,
    lastKnownTotal: 0,
    individualQueue: [],
    individualIndex: 0,
    dirty: true,
  };
}

// ═══════════════════════════════════════════════
//  Основной цикл
// ═══════════════════════════════════════════════

async function runPingerCycle(): Promise<void> {
  if (!pingerClient || isRunning) return;
  isRunning = true;

  try {
    for (const [guildId, state] of guildStates) {
      try {
        await processGuild(guildId, state);
      } catch (err) {
        log.error(`Ошибка пингера для гильдии ${guildId}`, { error: String(err) });
      }
    }
  } finally {
    isRunning = false;
  }
}

async function processGuild(guildId: string, state: GuildPingerState): Promise<void> {
  const client = pingerClient!;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    guildStates.delete(guildId);
    return;
  }

  const config = await getConfig(guildId);
  if (!config || !config.announceChannelId) {
    guildStates.delete(guildId);
    return;
  }

  const squads = await getGuildSquads(guildId);
  if (squads.length === 0) {
    state.phase = PingPhase.Idle;
    return;
  }

  // Подсчёт текущего состояния
  const squadInfos = squads.map((s: any) => ({
    number: s.number as number,
    count: getSquadMemberCount(guild, s.voiceChannelId, s.airChannelId),
    size: config.squadSize as number,
    voiceChannelId: s.voiceChannelId as string,
    ownerTag: guild.members.cache.get(s.ownerId)?.user.tag ?? 'Неизвестный',
    ownerId: s.ownerId as string,
  }));

  const totalMembers = squadInfos.reduce((sum: number, s) => sum + s.count, 0);
  const totalCapacity = squadInfos.reduce((sum: number, s) => sum + s.size, 0);
  const allFull = totalMembers >= totalCapacity;
  const anyUnfilled = squadInfos.some((s) => s.count < s.size);

  const now = Date.now();

  // Пересчёт фазы если dirty или при изменении состояния
  if (state.dirty) {
    if (allFull) {
      state.phase = PingPhase.Full;
    } else if (anyUnfilled) {
      // Проверить, нужна ли эскалация
      const escalateAfter = config.pingEscalateAfter ?? 6;
      const escalationCooldownMs = 30 * 60_000; // 30 минут между циклами именных пингов
      const cooledDown = now - state.lastEscalationEndedAt >= escalationCooldownMs;

      if (state.rolePingsWithoutProgress >= escalateAfter && cooledDown) {
        state.phase = PingPhase.Escalated;
      } else {
        state.phase = PingPhase.Recruiting;
      }
    } else {
      state.phase = PingPhase.Idle;
    }
    state.dirty = false;
  }

  // Обработка по фазе
  switch (state.phase) {
    case PingPhase.Recruiting:
      await handleRecruiting(guild, config, squadInfos, state, now);
      break;

    case PingPhase.Escalated:
      await handleEscalated(guild, config, squadInfos, state, now);
      break;

    case PingPhase.Full:
      await handleFull(guild, config, state, now);
      break;
  }

  // Обновить lastKnownTotal для отслеживания прогресса
  if (totalMembers > state.lastKnownTotal) {
    // Прогресс! Сбросить счётчик
    state.rolePingsWithoutProgress = 0;
    if (state.phase === PingPhase.Escalated && anyUnfilled) {
      state.phase = PingPhase.Recruiting; // Деэскалация
    }
  }
  state.lastKnownTotal = totalMembers;
}

// ═══════════════════════════════════════════════
//  Фаза: RECRUITING — пинг роли каждые 5 мин
// ═══════════════════════════════════════════════

async function handleRecruiting(
  guild: Guild,
  config: any,
  squadInfos: { number: number; count: number; size: number; voiceChannelId: string; ownerTag: string }[],
  state: GuildPingerState,
  now: number,
): Promise<void> {
  if (now - state.lastRolePingAt < ROLE_PING_INTERVAL_MS) return;

  try {
    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) return;

    const pingText = config.pingRoleId ? `<@&${config.pingRoleId}>` : '';

    await channel.send({
      content: pingText || undefined,
      embeds: [buildRecruitPingEmbed(squadInfos)],
    });

    state.lastRolePingAt = now;
    state.rolePingsWithoutProgress++;

    // Проверить эскалацию
    const escalateAfter = config.pingEscalateAfter ?? 6;
    const escalationCooldownMs = 30 * 60_000;
    const cooledDown = now - state.lastEscalationEndedAt >= escalationCooldownMs;

    if (state.rolePingsWithoutProgress >= escalateAfter && cooledDown) {
      state.phase = PingPhase.Escalated;
      state.individualQueue = [];
      state.individualIndex = 0;
      log.info(`Пингер гильдии ${guild.id}: эскалация к именным пингам`);
    }
  } catch (err) {
    log.error('Ошибка пинга роли', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Фаза: ESCALATED — именные пинги каждые 30 сек
// ═══════════════════════════════════════════════

async function handleEscalated(
  guild: Guild,
  config: any,
  squadInfos: { number: number; count: number; size: number; voiceChannelId: string; ownerTag: string }[],
  state: GuildPingerState,
  now: number,
): Promise<void> {
  if (now - state.lastIndividualPingAt < INDIVIDUAL_PING_INTERVAL_MS) return;

  // Обновить очередь если пустая или исчерпана
  if (state.individualQueue.length === 0 || state.individualIndex >= state.individualQueue.length) {
    await refreshIndividualQueue(guild, config, state);
    if (state.individualQueue.length === 0) {
      // Нет доступных бойцов → завершить цикл эскалации
      state.phase = PingPhase.Recruiting;
      state.rolePingsWithoutProgress = 0;
      state.lastEscalationEndedAt = now;
      log.info(`Пингер гильдии ${guild.id}: именные пинги завершены, кулдаун 30 мин`);
      return;
    }
  }

  const userId = state.individualQueue[state.individualIndex];
  state.individualIndex++;

  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) return;

    const unfilled = squadInfos.filter((s) => s.count < s.size);
    if (unfilled.length === 0) return;

    const text = buildIndividualPingMessage(member, unfilled);
    if (text) {
      await channel.send({ content: text });
    }

    state.lastIndividualPingAt = now;
  } catch (err) {
    log.error(`Ошибка именного пинга для ${userId}`, { error: String(err) });
  }
}

/**
 * Обновить очередь бойцов для именного пинга.
 * Берёт всех с pingRoleId, исключая уже находящихся в ПБ.
 */
async function refreshIndividualQueue(guild: Guild, config: any, state: GuildPingerState): Promise<void> {
  if (!config.pingRoleId) {
    state.individualQueue = [];
    return;
  }

  try {
    const role = guild.roles.cache.get(config.pingRoleId);
    if (!role) {
      state.individualQueue = [];
      return;
    }

    const pbChannelIds = await getAllPbChannelIds(guild.id);

    const available = role.members
      .filter((m) => {
        if (m.user.bot) return false;
        // Исключить тех, кто уже в ПБ-войсе
        const voiceId = m.voice.channelId;
        if (voiceId && pbChannelIds.includes(voiceId)) return false;
        return true;
      })
      .map((m) => m.id);

    // Перемешать (чтобы не пинговать одних и тех же первыми)
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    state.individualQueue = available;
    state.individualIndex = 0;
  } catch {
    state.individualQueue = [];
  }
}

// ═══════════════════════════════════════════════
//  Фаза: FULL — предложение запасных каждые 15 мин
// ═══════════════════════════════════════════════

async function handleFull(
  guild: Guild,
  config: any,
  state: GuildPingerState,
  now: number,
): Promise<void> {
  if (!config.reserveChannelId) return;
  if (now - state.lastFullSuggestAt < FULL_SUGGEST_INTERVAL_MS) return;

  try {
    const channel = await guild.client.channels.fetch(config.announceChannelId) as TextChannel;
    if (!channel) return;

    const pingText = config.pingRoleId ? `<@&${config.pingRoleId}>` : '';

    await channel.send({
      content: pingText || undefined,
      embeds: [buildFullSuggestEmbed(config.reserveChannelId)],
    });

    state.lastFullSuggestAt = now;
  } catch (err) {
    log.error('Ошибка предложения запасных', { error: String(err) });
  }
}
