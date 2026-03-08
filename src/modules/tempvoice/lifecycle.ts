// ═══════════════════════════════════════════════
//  TempVoice — Жизненный цикл каналов
//  Создание, удаление, восстановление, очистка
// ═══════════════════════════════════════════════

import {
  VoiceState,
  VoiceChannel,
  ChannelType,
  PermissionsBitField,
  GuildMember,
} from 'discord.js';
import type { TempVoiceGenerator } from '@prisma/client';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

import {
  ChannelState,
  EMPTY_DELETE_DELAY_MS,
  CLEANUP_INTERVAL_MS,
  MAX_INACTIVE_MS,
} from './constants';

import {
  getGenerator,
  getChannel,
  createChannel,
  deleteChannel,
  updateChannel,
  getUserChannels,
  getGuildChannels,
  getInactiveChannels,
  getUserSettings,
} from './database';

import {
  resolveChannelName,
  buildPermissionOverwrites,
  acquireCreationLock,
  releaseCreationLock,
  isCreationCooldown,
} from './utils';

import {
  buildMainPageEmbed,
  buildMainPageButtons,
} from './embeds';

const log = logger.child('TempVoice:Lifecycle');

// Таймеры удаления пустых каналов (channelId → timeout)
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Таймер очистки неактивных каналов
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════
//  voiceStateUpdate — ядро системы
// ═══════════════════════════════════════════════

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: BublikClient,
): Promise<void> {
  try {
    // Пользователь присоединился к каналу
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      await onJoinChannel(newState, client);
    }

    // Пользователь покинул канал
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await onLeaveChannel(oldState, client);
    }
  } catch (err) {
    log.error('Ошибка в voiceStateUpdate', { error: String(err) });
    errorReporter.eventError(err, 'voiceStateUpdate', 'tempvoice');
  }
}

// ═══════════════════════════════════════════════
//  Присоединение к каналу
// ═══════════════════════════════════════════════

async function onJoinChannel(state: VoiceState, client: BublikClient): Promise<void> {
  const channelId = state.channelId!;
  const member = state.member;
  if (!member || member.user.bot) return;

  // 1. Проверить: вошли ли в канал-генератор?
  const generator = await getGenerator(channelId);
  if (generator) {
    await createTempChannel(state, member, generator, client);
    return;
  }

  // 2. Проверить: вошли ли в существующий temp-канал?
  const channelData = await getChannel(channelId);
  if (channelData) {
    // Отменить таймер удаления если был
    const timer = deleteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      deleteTimers.delete(channelId);
    }

    // Обновить lastActivity
    await updateChannel(channelId, {}).catch(() => null);
  }
}

// ═══════════════════════════════════════════════
//  Создание временного канала
// ═══════════════════════════════════════════════

async function createTempChannel(
  state: VoiceState,
  member: GuildMember,
  generator: TempVoiceGenerator,
  client: BublikClient,
): Promise<void> {
  // Anti-race: блокировка создания
  if (!acquireCreationLock(member.id)) {
    log.debug(`Создание канала заблокировано (lock) для ${member.user.tag}`);
    return;
  }

  try {
    // Кулдаун создания
    if (isCreationCooldown(member.id)) {
      await member.voice.disconnect('Кулдаун создания канала').catch(() => null);
      releaseCreationLock(member.id);
      return;
    }

    // Лимит каналов на пользователя
    const existing = await getUserChannels(member.id, state.guild.id);
    if (existing.length >= generator.maxChannelsPerUser) {
      await member.voice.disconnect('Превышен лимит каналов').catch(() => null);
      releaseCreationLock(member.id);
      log.debug(`Лимит каналов для ${member.user.tag}: ${existing.length}/${generator.maxChannelsPerUser}`);
      return;
    }

    // Загрузить сохранённые настройки пользователя
    const userSettings = await getUserSettings(member.id, state.guild.id);

    // Подсчёт для {count}
    const guildChannels = await getGuildChannels(state.guild.id);
    const count = guildChannels.length + 1;

    // Имя канала
    const nameTemplate = userSettings?.savedName ?? generator.defaultName;
    const channelName = resolveChannelName(nameTemplate, member, count);

    // Параметры канала
    const userLimit = userSettings?.savedLimit ?? generator.defaultLimit;
    const bitrate = userSettings?.savedBitrate ?? generator.defaultBitrate;
    const regionSetting = userSettings?.savedRegion ?? generator.defaultRegion;
    const region = regionSetting === 'auto' ? null : regionSetting;

    // Создать голосовой канал
    const vc = await state.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: generator.categoryId,
      userLimit,
      bitrate: Math.min(bitrate, getMaxBitrate(state.guild.premiumTier)),
      rtcRegion: region ?? undefined,
    });

    // Сохранить в БД
    const channelData = await createChannel({
      id: vc.id,
      guildId: state.guild.id,
      ownerId: member.id,
      generatorId: generator.id,
      state: generator.initialState,
    });

    // Установить permissions (включая права бота для панели)
    const overwrites = await buildPermissionOverwrites(channelData, generator, state.guild, client.user!.id);
    await vc.permissionOverwrites.set(overwrites).catch((e) =>
      log.error('Ошибка установки прав при создании', { error: String(e) }),
    );

    // Переместить пользователя
    await member.voice.setChannel(vc, 'Создание временного канала').catch(() => null);

    // Небольшая задержка чтобы Discord применил права перед отправкой сообщения
    await new Promise((r) => setTimeout(r, 500));

    // Отправить панель управления в текстовый чат VC
    await sendControlPanel(vc, channelData, generator, member);

    log.info(`Создан канал "${channelName}" (${vc.id}) для ${member.user.tag}`);
  } catch (err) {
    log.error(`Ошибка создания temp-канала для ${member.user.tag}`, { error: String(err) });
    errorReporter.moduleError(err, 'tempvoice', `Создание канала для ${member.user.tag}`);
  } finally {
    releaseCreationLock(member.id);
  }
}

/** Получить макс. битрейт по уровню буста сервера */
function getMaxBitrate(tier: number): number {
  switch (tier) {
    case 1: return 128_000;
    case 2: return 256_000;
    case 3: return 384_000;
    default: return 96_000;
  }
}

// ═══════════════════════════════════════════════
//  Панель управления в текстовом чате VC
// ═══════════════════════════════════════════════

export async function sendControlPanel(
  vc: VoiceChannel,
  channelData: { id: string; ownerId: string; state: string },
  generator: TempVoiceGenerator,
  owner: GuildMember,
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const embed = buildMainPageEmbed(
        owner.user.tag,
        vc.name,
        channelData.state,
        vc.members.size,
        vc.userLimit,
        vc.bitrate,
      );

      const msg = await vc.send({
        embeds: [embed],
        components: buildMainPageButtons(),
      });

      // Сохранить ID сообщения для обновлений
      await updateChannel(channelData.id, { controlMsgId: msg.id });
      return; // Успех — выходим
    } catch (err) {
      if (attempt < maxRetries) {
        log.debug(`Панель: попытка ${attempt}/${maxRetries} не удалась для ${vc.id}, повтор через 1с…`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        log.warn(`Не удалось отправить панель в канал ${vc.id} после ${maxRetries} попыток`, { error: String(err) });
      }
    }
  }
}

// ═══════════════════════════════════════════════
//  Покидание канала
// ═══════════════════════════════════════════════

async function onLeaveChannel(state: VoiceState, client: BublikClient): Promise<void> {
  const channelId = state.channelId!;

  const channelData = await getChannel(channelId);
  if (!channelData) return;

  // Получить канал из Discord (сначала кэш, потом fetch)
  let vc = state.guild.channels.cache.get(channelId) as VoiceChannel | undefined;
  if (!vc) {
    try {
      const fetched = await state.guild.channels.fetch(channelId).catch(() => null);
      if (fetched && fetched.type === ChannelType.GuildVoice) vc = fetched as VoiceChannel;
    } catch { /* ignore */ }
  }

  if (!vc) {
    // Канал уже удалён из Discord — чистим БД
    await deleteChannel(channelId);
    return;
  }

  // Если канал пуст — запустить таймер удаления
  if (vc.members.size === 0) {
    // Не запускать второй таймер
    if (deleteTimers.has(channelId)) return;

    const timer = setTimeout(async () => {
      deleteTimers.delete(channelId);

      // Перепроверить: fetch канал заново
      let fresh: VoiceChannel | undefined;
      try {
        const f = await state.guild.channels.fetch(channelId).catch(() => null);
        if (f && f.type === ChannelType.GuildVoice) fresh = f as VoiceChannel;
      } catch { /* ignore */ }

      if (!fresh || fresh.members.size === 0) {
        await deleteChannel(channelId);
        if (fresh) await fresh.delete('Временный канал пуст').catch(() => null);
        log.info(`Удалён пустой канал ${channelId}`);
      }
    }, EMPTY_DELETE_DELAY_MS);

    deleteTimers.set(channelId, timer);
  }
}

// ═══════════════════════════════════════════════
//  Восстановление при старте бота
// ═══════════════════════════════════════════════

export async function restoreChannels(client: BublikClient): Promise<void> {
  try {
    for (const [, guild] of client.guilds.cache) {
      const channels = await getGuildChannels(guild.id);

      for (const channelData of channels) {
        const vc = guild.channels.cache.get(channelData.id);

        if (!vc) {
          // Канал не существует в Discord — удалить запись
          await deleteChannel(channelData.id);
          log.debug(`Cleanup: удалена запись для несуществующего канала ${channelData.id}`);
          continue;
        }

        // Если пуст — запланировать удаление
        if (vc.type === ChannelType.GuildVoice && (vc as VoiceChannel).members.size === 0) {
          const timer = setTimeout(async () => {
            deleteTimers.delete(channelData.id);
            const fresh = guild.channels.cache.get(channelData.id) as VoiceChannel | undefined;
            if (fresh && fresh.members.size === 0) {
              await deleteChannel(channelData.id);
              await fresh.delete('Временный канал пуст (после перезапуска)').catch(() => null);
              log.info(`Cleanup: удалён пустой канал ${channelData.id}`);
            }
          }, EMPTY_DELETE_DELAY_MS);
          deleteTimers.set(channelData.id, timer);
        }
      }
    }

    log.info('Каналы восстановлены');
  } catch (err) {
    log.error('Ошибка восстановления каналов', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Периодическая очистка неактивных каналов
// ═══════════════════════════════════════════════

export function startCleanupTimer(client: BublikClient): void {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(async () => {
    try {
      const inactive = await getInactiveChannels(MAX_INACTIVE_MS);

      for (const channelData of inactive) {
        const guild = client.guilds.cache.get(channelData.guildId);
        if (!guild) continue;

        const vc = guild.channels.cache.get(channelData.id) as VoiceChannel | undefined;

        // Если канал всё ещё с людьми — просто обновить lastActivity
        if (vc && vc.members.size > 0) {
          await updateChannel(channelData.id, {});
          continue;
        }

        // Удалить
        await deleteChannel(channelData.id);
        if (vc) await vc.delete('Неактивный временный канал (>24ч)').catch(() => null);
        log.info(`Cleanup: удалён неактивный канал ${channelData.id}`);
      }
    } catch (err) {
      log.error('Ошибка очистки неактивных каналов', { error: String(err) });
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  // Отменить все pending delete таймеры
  for (const timer of deleteTimers.values()) {
    clearTimeout(timer);
  }
  deleteTimers.clear();
}
