// ═══════════════════════════════════════════════
//  TempVoice — Жизненный цикл каналов
//  Создание, удаление, восстановление, очистка
// ═══════════════════════════════════════════════

import {
  VoiceState,
  VoiceChannel,
  ChannelType,
  GuildMember,
  Guild,
} from 'discord.js';
import type { TempvoiceGenerator } from '@prisma/client';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { i18n } from '../../core/I18n';
import { getGuildLocale } from '../../core/GuildConfig';
import { scheduleTask, unscheduleTask } from '../../core/SchedulerManager';
import { isGuildAllowed } from '../../core/Whitelist';
import { getDatabase } from '../../core/Database';
import { fetchSafeAutomaticRole, UnsafeAutomaticRoleError } from '../../core/RolePolicy';
import { withMemberRoleLock } from '../../core/MemberRoleLock';

import {
  PanelPage,
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
  addVoiceMinutesOnce,
  cleanupExpiredVoiceClaims,
  markRewardGranted,
  getGeneratorById,
  getTrusted,
  getBlocked,
} from './database';

import {
  resolveChannelName,
  acquireCreationLock,
  releaseCreationLock,
  isCreationCooldown,
  setVoiceSessionIfAbsent,
  getVoiceSession as getVoiceSessionFromRedis,
  listVoiceSessions,
  closeVoiceSessionToOutbox,
  listPendingVoiceSettlements,
  deletePendingVoiceSettlement,
} from './utils';
import { runGeneratorExclusive, runPermissionMutation } from './permissionSync';
import type { PendingVoiceSettlement } from './recovery';
import {
  isTempVoiceRewardGrantPending,
  isUnknownChannelError,
  MissingRewardRoleRetryGate,
} from './recovery';
import {
  cleanupTempVoiceCreationIntent,
  completeTempVoiceCreation,
  prepareTempVoiceCreation,
  recoverTempVoiceCreationIntents,
  recordTempVoiceCreationChannel,
  type TempVoiceCreationIntent,
} from './creationRecovery';

import {
  buildMainPageEmbed,
  buildMainPageButtons,
  buildAccessPageEmbed,
  buildSettingsPageEmbed,
  buildRewardAnnouncement,
} from './embeds';

const log = logger.child('TempVoice:Lifecycle');
const missingRewardRoleRetryGate = new MissingRewardRoleRetryGate();
const rewardRoleAttempts = new Set<string>();

// Таймеры удаления пустых каналов (channelId → timeout)
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

type VoiceChannelLookup =
  | { status: 'found'; channel: VoiceChannel }
  | { status: 'confirmed-absent' }
  | { status: 'wrong-type' }
  | { status: 'unavailable' };

/** A cache miss is not proof of deletion; only REST 10003 is. */
async function fetchVoiceChannel(
  guild: Guild,
  channelId: string,
  force = false,
): Promise<VoiceChannelLookup> {
  const cached = guild.channels.cache.get(channelId);
  if (!force && cached) {
    return cached.type === ChannelType.GuildVoice
      ? { status: 'found', channel: cached as VoiceChannel }
      : { status: 'wrong-type' };
  }
  try {
    const fetched = await guild.channels.fetch(channelId, { force });
    if (!fetched) return { status: 'unavailable' };
    if (fetched.type !== ChannelType.GuildVoice) return { status: 'wrong-type' };
    return { status: 'found', channel: fetched as VoiceChannel };
  } catch (error) {
    if (isUnknownChannelError(error)) return { status: 'confirmed-absent' };
    log.warn(`Discord lookup канала ${channelId} временно недоступен`, { error: String(error) });
    return { status: 'unavailable' };
  }
}

// Сессии голосового времени удалены из in-memory (теперь в Redis)

async function settlePendingVoiceTime(
  pending: PendingVoiceSettlement,
  client: BublikClient,
  memberHint?: GuildMember,
): Promise<void> {
  if (!isGuildAllowed(pending.guildId)) return;

  const { settings } = await addVoiceMinutesOnce(
    pending.userId,
    pending.guildId,
    pending.minutes,
    pending.sessionId,
  );

  const generator = await getGeneratorById(pending.generatorId);
  const retryGateKey = `${pending.guildId}:${pending.generatorId}`;
  if (generator && isTempVoiceRewardGrantPending(
    generator.rewardRoleId,
    generator.rewardThresholdMin,
    settings.totalVoiceMinutes,
    settings.rewardGranted,
  )) {
    const rewardRoleId = generator.rewardRoleId!;
    if (!missingRewardRoleRetryGate.canAttempt(retryGateKey, rewardRoleId)) return;

    const guild = client.guilds.cache.get(pending.guildId);
    if (!guild) {
      throw new Error(`TempVoice reward guild ${pending.guildId} is not available`);
    }
    const member = memberHint?.guild.id === pending.guildId && memberHint.id === pending.userId
      ? memberHint
      : await guild.members.fetch({ user: pending.userId, force: true });
    if (
      rewardRoleAttempts.has(retryGateKey) ||
      !missingRewardRoleRetryGate.canAttempt(retryGateKey, rewardRoleId)
    ) return;
    rewardRoleAttempts.add(retryGateKey);
    try {
      await grantRewardRole(member, generator, settings.totalVoiceMinutes, client);
      missingRewardRoleRetryGate.release(retryGateKey, rewardRoleId);
    } catch (error) {
      if (
        error instanceof UnsafeAutomaticRoleError &&
        error.reason === 'role_missing' &&
        error.roleId === rewardRoleId
      ) {
        const quarantine = missingRewardRoleRetryGate.quarantine(retryGateKey, rewardRoleId);
        log.warn('TempVoice reward settlement quarantined: configured role is missing', {
          guildId: pending.guildId,
          generatorId: pending.generatorId,
          roleId: rewardRoleId,
          retryAt: new Date(quarantine.retryAt).toISOString(),
          failures: quarantine.failures,
        });
        return;
      }
      throw error;
    } finally {
      rewardRoleAttempts.delete(retryGateKey);
    }
  } else {
    // A removed generator or disabled/replaced reward resolves stale
    // quarantine. An ineligible member must not release quarantine for other
    // members affected by the same still-missing role.
    if (!generator?.rewardRoleId) {
      missingRewardRoleRetryGate.release(retryGateKey);
    } else {
      missingRewardRoleRetryGate.canAttempt(retryGateKey, generator.rewardRoleId);
    }
  }

  // Deleting after both the idempotent accounting transaction and any required
  // verified reward grant makes crashes safe. A repeated settlement is ignored
  // by OperationClaim in addVoiceMinutesOnce().
  await deletePendingVoiceSettlement(pending.sessionId);
}

async function retryPendingVoiceSettlements(client: BublikClient): Promise<void> {
  const pending = await listPendingVoiceSettlements();
  for (const settlement of pending) {
    if (!isGuildAllowed(settlement.guildId)) continue;
    try {
      await settlePendingVoiceTime(settlement, client);
    } catch (error) {
      log.warn(`Отложенное начисление ${settlement.sessionId} будет повторено`, {
        error: String(error),
      });
    }
  }
}

async function startVoiceAccountingSession(
  guildId: string,
  userId: string,
  channelId: string,
  generatorId: string,
  client: BublikClient,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getVoiceSessionFromRedis(guildId, userId);
    if (existing?.channelId === channelId) return;

    let pending: PendingVoiceSettlement | null = null;
    if (existing) {
      const closed = await closeVoiceSessionToOutbox(guildId, userId, existing);
      if (!closed.closed) continue;
      pending = closed.pending;
    }

    const started = await setVoiceSessionIfAbsent(guildId, userId, {
      joinedAt: Date.now(),
      channelId,
      generatorId,
    });

    if (pending) {
      try {
        await settlePendingVoiceTime(pending, client);
      } catch (error) {
        log.warn(`Предыдущая voice-сессия ${pending.sessionId} сохранена для повтора`, {
          error: String(error),
        });
      }
    }
    if (started) return;
  }

  throw new Error(`Не удалось атомарно начать voice-сессию ${guildId}:${userId}:${channelId}`);
}

// ═══════════════════════════════════════════════
//  voiceStateUpdate — ядро системы
// ═══════════════════════════════════════════════

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: BublikClient,
): Promise<void> {
  // Сначала закрываем старую сессию, затем открываем новую. Ошибки фаз
  // изолированы: сбой начисления за старый канал не должен мешать начать
  // учёт времени в новом канале.
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    try {
      await onLeaveChannel(oldState, client);
    } catch (err) {
      log.error('Ошибка выхода в voiceStateUpdate', { error: String(err) });
      errorReporter.eventError(err, 'voiceStateUpdate:leave', 'tempvoice');
    }
  }

  if (newState.channelId && newState.channelId !== oldState.channelId) {
    try {
      await onJoinChannel(newState, client);
    } catch (err) {
      log.error('Ошибка входа в voiceStateUpdate', { error: String(err) });
      errorReporter.eventError(err, 'voiceStateUpdate:join', 'tempvoice');
    }
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

    if (state.channel && state.channel.type === ChannelType.GuildVoice) {
      await updateControlPanel(state.channel as VoiceChannel, client).catch(() => null);
    }

    // Начать отслеживание голосового времени
    await startVoiceAccountingSession(
      member.guild.id,
      member.id,
      channelId,
      channelData.generatorId,
      client,
    );
  }
}

// ═══════════════════════════════════════════════
//  Создание временного канала
// ═══════════════════════════════════════════════

async function createTempChannel(
  state: VoiceState,
  member: GuildMember,
  generator: TempvoiceGenerator,
  client: BublikClient,
): Promise<void> {
  // Anti-race: блокировка создания
  if (!acquireCreationLock(member.id)) {
    log.debug(`Создание канала заблокировано (lock) для ${member.user.tag}`);
    return;
  }

  const creationState: { intent: TempVoiceCreationIntent | null } = { intent: null };

  try {
    await runGeneratorExclusive(generator.id, async (assertGeneratorOwned) => {
      const currentGenerator = await getDatabase().tempvoiceGenerator.findUnique({
        where: { id: generator.id },
      });
      if (
        !currentGenerator ||
        currentGenerator.guildId !== state.guild.id ||
        currentGenerator.channelId !== state.channelId
      ) {
        await member.voice.disconnect('Генератор временных каналов удалён').catch(() => null);
        return;
      }

      if (isCreationCooldown(member.id)) {
        await member.voice.disconnect('Кулдаун создания канала').catch(() => null);
        return;
      }

      const existing = await getUserChannels(member.id, state.guild.id);
      if (existing.length >= currentGenerator.maxChannelsPerUser) {
        await member.voice.disconnect('Превышен лимит каналов').catch(() => null);
        log.debug(`Лимит каналов для ${member.user.tag}: ${existing.length}/${currentGenerator.maxChannelsPerUser}`);
        return;
      }

      const userSettings = await getUserSettings(member.id, state.guild.id);
      const guildChannels = await getGuildChannels(state.guild.id);
      const count = guildChannels.length + 1;
      const nameTemplate = userSettings?.savedName ?? currentGenerator.defaultName;
      const channelName = resolveChannelName(nameTemplate, member, count);
      const userLimit = userSettings?.savedLimit ?? currentGenerator.defaultLimit;
      const bitrate = userSettings?.savedBitrate ?? currentGenerator.defaultBitrate;
      const regionSetting = userSettings?.savedRegion ?? currentGenerator.defaultRegion;
      const region = regionSetting === 'auto' ? null : regionSetting;

      if (!isGuildAllowed(state.guild.id)) return;
      creationState.intent = await prepareTempVoiceCreation(
        state.guild.id,
        member.id,
        currentGenerator.id,
        currentGenerator.categoryId,
        channelName,
      );
      if (!creationState.intent) {
        log.warn(`Создание TempVoice для ${member.user.tag} уже имеет durable intent`);
        return;
      }

      await assertGeneratorOwned();
      const vc = await state.guild.channels.create({
        // The crash gap before Discord returns is discoverable by
        // this durable marker. It is removed only after channelId is persisted.
        name: creationState.intent.markedName,
        type: ChannelType.GuildVoice,
        parent: currentGenerator.categoryId,
        userLimit,
        bitrate: Math.min(bitrate, getMaxBitrate(state.guild.premiumTier)),
        rtcRegion: region ?? undefined,
      });
      creationState.intent = await recordTempVoiceCreationChannel(creationState.intent, vc.id);
      await assertGeneratorOwned();

      const { value: channelData } = await runPermissionMutation(
        client,
        state.guild.id,
        vc.id,
        'channel creation',
        () => createChannel({
          id: vc.id,
          guildId: state.guild.id,
          ownerId: member.id,
          generatorId: currentGenerator.id,
          state: currentGenerator.initialState,
        }),
      );

      await vc.setName(channelName, 'TempVoice: завершение durable creation intent');
      await member.voice.setChannel(vc, 'Создание временного канала');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await sendControlPanel(vc, channelData, currentGenerator, member);
      await startVoiceAccountingSession(
        state.guild.id,
        member.id,
        vc.id,
        currentGenerator.id,
        client,
      );
      await assertGeneratorOwned();
      await completeTempVoiceCreation(creationState.intent);
      creationState.intent = null;
      log.info(`Создан канал "${channelName}" (${vc.id}) для ${member.user.tag}`);
    });
  } catch (err) {
    if (creationState.intent) {
      const pendingIntent = creationState.intent;
      const cleaned = await cleanupTempVoiceCreationIntent(client, pendingIntent).catch(() => false);
      if (!cleaned) {
        log.warn(`Durable creation intent ${pendingIntent.token} сохранён для recovery`);
      }
    }
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
  generator: TempvoiceGenerator,
  owner: GuildMember,
): Promise<void> {
  const locale = await getGuildLocale(vc.guildId);
  const maxRetries = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const embed = buildMainPageEmbed(
        owner.user.tag,
        vc.name,
        channelData.state,
        vc.members.size,
        vc.userLimit,
        vc.bitrate,
        locale,
      );

      const msg = await vc.send({
        embeds: [embed],
        components: buildMainPageButtons(locale),
      });

      // Сохранить ID сообщения для обновлений
      await updateChannel(channelData.id, { controlMsgId: msg.id });
      return; // Успех — выходим
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        log.debug(`Панель: попытка ${attempt}/${maxRetries} не удалась для ${vc.id}, повтор через 1с…`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        log.warn(`Не удалось отправить панель в канал ${vc.id} после ${maxRetries} попыток`, { error: String(err) });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось создать панель управления tempvoice');
}

/** Keep the database in sync when a moderator deletes a temp channel manually. */
export async function handleTempChannelDelete(channelId: string): Promise<void> {
  const timer = deleteTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    deleteTimers.delete(channelId);
  }
  if (await getChannel(channelId)) await deleteChannel(channelId);
}

// ═══════════════════════════════════════════════
//  Покидание канала
// ═══════════════════════════════════════════════

async function onLeaveChannel(state: VoiceState, client: BublikClient): Promise<void> {
  const channelId = state.channelId!;
  const member = state.member;

  // Засчитать голосовое время при выходе
  if (member && !member.user.bot) {
    const session = await getVoiceSessionFromRedis(state.guild.id, member.id);
    // Удалять можно только сессию именно покидаемого канала. Это защищает от
    // out-of-order voiceStateUpdate и вложенного события после setChannel().
    if (session && session.channelId === channelId) {
      const { pending } = await closeVoiceSessionToOutbox(
        state.guild.id,
        member.id,
        session,
      );
      if (pending) {
        try {
          await settlePendingVoiceTime(pending, client, member);
        } catch (err) {
          // The Redis outbox remains durable. A join can now safely create the
          // next session without overwriting these minutes.
          log.error(`Voice time ${pending.sessionId} сохранён для повторного начисления`, {
            error: String(err),
          });
        }
      }
    }
  }

  const channelData = await getChannel(channelId);
  if (!channelData) return;

  // Получить канал из Discord (сначала кэш, потом fetch)
  const lookup = await fetchVoiceChannel(state.guild, channelId);
  if (lookup.status === 'confirmed-absent' || lookup.status === 'wrong-type') {
    await deleteChannel(channelId);
    return;
  }
  if (lookup.status !== 'found') return;
  const vc = lookup.channel;

  // Если канал пуст — запустить таймер удаления
  if (vc.members.size === 0) {
    // Не запускать второй таймер
    if (deleteTimers.has(channelId)) return;

    const timer = setTimeout(async () => {
      deleteTimers.delete(channelId);
      if (!isGuildAllowed(state.guild.id)) return;

      // Перепроверить: fetch канал заново
      const freshLookup = await fetchVoiceChannel(state.guild, channelId, true);
      if (freshLookup.status === 'confirmed-absent' || freshLookup.status === 'wrong-type') {
        try {
          await deleteChannel(channelId);
        } catch (err) {
          log.warn(`Не удалось очистить запись исчезнувшего канала ${channelId}`, { error: String(err) });
        }
        return;
      }
      if (freshLookup.status !== 'found') return;
      const fresh = freshLookup.channel;
      if (fresh.members.size === 0) {
        if (!isGuildAllowed(state.guild.id)) return;
        try {
          await fresh.delete('Временный канал пуст');
          await deleteChannel(channelId);
          log.info(`Удалён пустой канал ${channelId}`);
        } catch (err) {
          if (isUnknownChannelError(err)) {
            await deleteChannel(channelId).catch(() => null);
            return;
          }
          // Запись остаётся, поэтому периодическая очистка сможет повторить REST-вызов.
          log.warn(`Не удалось удалить пустой канал ${channelId}`, { error: String(err) });
        }
      }
    }, EMPTY_DELETE_DELAY_MS);

    deleteTimers.set(channelId, timer);
  } else {
    // Обновить панель управления, так как количество участников изменилось
    await updateControlPanel(vc, client).catch(() => null);
  }
}

// ═══════════════════════════════════════════════
//  Выдача наградной роли
// ═══════════════════════════════════════════════

async function grantRewardRole(
  member: GuildMember,
  generator: TempvoiceGenerator,
  totalMinutes: number,
  _client: BublikClient,
): Promise<void> {
  if (!generator.rewardRoleId) return;

  try {
    const grantedMember = await withMemberRoleLock(member.guild.id, member.id, async (lock) => {
      const freshMember = await member.guild.members.fetch({ user: member.id, force: true });
      if (freshMember.roles.cache.has(generator.rewardRoleId!)) {
        await markRewardGranted(freshMember.id, freshMember.guild.id);
        return null;
      }
      const rewardRole = await fetchSafeAutomaticRole(member.guild, generator.rewardRoleId!);
      await lock.assertOwned();
      await freshMember.roles.add(rewardRole, 'TempVoice: наградная роль за активность');
      const verified = await member.guild.members.fetch({ user: member.id, force: true });
      if (!verified.roles.cache.has(rewardRole.id)) {
        throw new Error(`TempVoice reward role ${rewardRole.id} was not confirmed`);
      }
      await lock.assertOwned();
      await markRewardGranted(member.id, member.guild.id);
      return verified;
    });
    if (!grantedMember) return;

    const hours = Math.floor(totalMinutes / 60);

    log.info(`Награда: ${grantedMember.user.tag} получил роль за ${hours}ч в войсе (${grantedMember.guild.name})`);

    // Отправить объявление
    if (generator.rewardAnnounceChId) {
      try {
        const announceChannel = await grantedMember.guild.channels.fetch(generator.rewardAnnounceChId).catch(() => null);
        if (announceChannel && announceChannel.isTextBased()) {
          await announceChannel.send({
            embeds: [buildRewardAnnouncement(grantedMember, hours, generator.rewardRoleId, await getGuildLocale(grantedMember.guild.id))],
          });
        }
      } catch (err) {
        log.warn('Не удалось отправить объявление о награде', { error: String(err) });
      }
    }
  } catch (err) {
    if (!(err instanceof UnsafeAutomaticRoleError && err.reason === 'role_missing')) {
      log.error(`Ошибка выдачи наградной роли для ${member.user.tag}`, { error: String(err) });
    }
    // Settlement/outbox deletion happens only after this function resolves.
    // Propagate every uncertain mutation or persistence failure so recovery can
    // force-fetch Discord and retry instead of losing the durable reward work.
    throw err;
  }
}

// ═══════════════════════════════════════════════
//  Восстановление при старте бота
// ═══════════════════════════════════════════════

export async function restoreChannels(
  client: BublikClient,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    if (!isCurrent()) return;
    await retryPendingVoiceSettlements(client);
    if (!isCurrent()) return;
    const storedSessions = await listVoiceSessions();
    const activeSessionKeys = new Set<string>();
    const incompleteGuilds = new Set<string>();

    for (const [, guild] of client.guilds.cache) {
      if (!isCurrent()) return;
      if (!isGuildAllowed(guild.id)) continue;
      const channels = await getGuildChannels(guild.id);

      for (const channelData of channels) {
        if (!isCurrent()) return;
        const lookup = await fetchVoiceChannel(guild, channelData.id, true);
        if (!isCurrent()) return;
        if (lookup.status === 'confirmed-absent' || lookup.status === 'wrong-type') {
          await deleteChannel(channelData.id);
          log.debug(`Cleanup: удалена запись для несуществующего канала ${channelData.id}`);
          continue;
        }
        if (lookup.status !== 'found') {
          incompleteGuilds.add(guild.id);
          continue;
        }
        const vc = lookup.channel;

        // Если пуст — запланировать удаление
        if (vc.members.size === 0) {
          if (!isCurrent()) return;
          const timer = setTimeout(async () => {
            deleteTimers.delete(channelData.id);
            if (!isGuildAllowed(guild.id)) return;
            if (!isCurrent()) return;
            const freshLookup = await fetchVoiceChannel(guild, channelData.id, true);
            if (freshLookup.status === 'confirmed-absent' || freshLookup.status === 'wrong-type') {
              await deleteChannel(channelData.id).catch((error: unknown) => {
                log.warn(`Cleanup: запись ${channelData.id} не удалена`, { error: String(error) });
              });
              return;
            }
            if (freshLookup.status === 'found' && freshLookup.channel.members.size === 0) {
              if (!isGuildAllowed(guild.id)) return;
              try {
                await freshLookup.channel.delete('Временный канал пуст (после перезапуска)');
                await deleteChannel(channelData.id);
                log.info(`Cleanup: удалён пустой канал ${channelData.id}`);
              } catch (err) {
                if (isUnknownChannelError(err)) {
                  await deleteChannel(channelData.id).catch(() => null);
                  return;
                }
                log.warn(`Cleanup: не удалось удалить канал ${channelData.id}`, { error: String(err) });
              }
            }
          }, EMPTY_DELETE_DELAY_MS);
          deleteTimers.set(channelData.id, timer);
        } else {
          const members = vc.members.filter((m) => !m.user.bot);
          for (const [memberId] of members) {
            if (!isCurrent()) return;
            activeSessionKeys.add(`${guild.id}:${memberId}`);
            await startVoiceAccountingSession(
              guild.id,
              memberId,
              channelData.id,
              channelData.generatorId,
              client,
            );
          }
        }
      }
    }

    // Не обнуляем joinedAt живых сессий при рестарте/hot-reload. Удаляем
    // только записи пользователей, которых действительно нет в temp-канале.
    for (const stored of storedSessions) {
      if (!isCurrent()) return;
      if (!isGuildAllowed(stored.guildId) || incompleteGuilds.has(stored.guildId)) continue;
      if (activeSessionKeys.has(`${stored.guildId}:${stored.userId}`)) continue;
      await closeVoiceSessionToOutbox(
        stored.guildId,
        stored.userId,
        stored.session,
      );
    }

    if (!isCurrent()) return;
    await retryPendingVoiceSettlements(client);

    log.info('Каналы восстановлены');
  } catch (err) {
    log.error('Ошибка восстановления каналов', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Периодическая очистка неактивных каналов
// ═══════════════════════════════════════════════

export function startCleanupTimer(client: BublikClient): void {
  scheduleTask('tempvoice:cleanup', CLEANUP_INTERVAL_MS, async () => {
    const allowedGuildIds = client.guilds.cache
      .filter((guild) => isGuildAllowed(guild.id))
      .map((guild) => guild.id);
    await cleanupExpiredVoiceClaims(allowedGuildIds);
    await recoverTempVoiceCreationIntents(client);
    await retryPendingVoiceSettlements(client);
    const inactive = await getInactiveChannels(MAX_INACTIVE_MS);

    for (const channelData of inactive) {
      if (!isGuildAllowed(channelData.guildId)) continue;
      const guild = client.guilds.cache.get(channelData.guildId);
      if (!guild) continue;

      const lookup = await fetchVoiceChannel(guild, channelData.id, true);
      if (lookup.status === 'confirmed-absent' || lookup.status === 'wrong-type') {
        await deleteChannel(channelData.id);
        continue;
      }
      if (lookup.status !== 'found') continue;
      const vc = lookup.channel;

      // Если канал всё ещё с людьми — просто обновить lastActivity
      if (vc.members.size > 0) {
        await updateChannel(channelData.id, {});
        continue;
      }

      try {
        await vc.delete('Неактивный временный канал (>24ч)');
        await deleteChannel(channelData.id);
        log.info(`Cleanup: удалён неактивный канал ${channelData.id}`);
      } catch (err) {
        if (isUnknownChannelError(err)) {
          await deleteChannel(channelData.id).catch(() => null);
          continue;
        }
        log.warn(`Cleanup: не удалось удалить неактивный канал ${channelData.id}`, { error: String(err) });
      }
    }
  });
}

export function stopCleanupTimer(): void {
  unscheduleTask('tempvoice:cleanup');

  // Отменить все pending delete таймеры
  for (const timer of deleteTimers.values()) {
    clearTimeout(timer);
  }
  deleteTimers.clear();
}

/** Получить текущую сессию пользователя (для /voice stats) */
export async function getVoiceSession(guildId: string, userId: string): Promise<{ joinedAt: number } | null> {
  return getVoiceSessionFromRedis(guildId, userId);
}

/** Автоматически обновить эмбед панели управления на основе текущей открытой страницы */
export async function updateControlPanel(vc: VoiceChannel, _client: BublikClient): Promise<void> {
  try {
    const channelData = await getChannel(vc.id);
    if (!channelData || !channelData.controlMsgId) return;

    const generator = await getGeneratorById(channelData.generatorId);
    if (!generator) return;

    // Пытаемся получить старое сообщение панели
    const msg = await vc.messages.fetch(channelData.controlMsgId).catch(() => null);
    if (!msg) return;

    // Определяем текущую активную страницу панели по кнопкам в сообщении
    let currentPage = PanelPage.Main;
    const components = msg.components;
    if (components && components.length > 0) {
      // Проверяем наличие кнопок навигации, чтобы понять, какая страница открыта
      const hasAccessNext = (components as any).some((row: any) =>
        row.components?.some((c: any) => c.customId?.includes(':page:access'))
      );
      const hasPrevMain = (components as any).some((row: any) =>
        row.components?.some((c: any) => c.customId?.includes(':page:main'))
      );
      const hasBitrate = (components as any).some((row: any) =>
        row.components?.some((c: any) => c.customId?.includes(':bitrate'))
      );

      if (hasAccessNext) {
        currentPage = PanelPage.Main;
      } else if (hasPrevMain) {
        currentPage = PanelPage.Access;
      } else if (hasBitrate) {
        currentPage = PanelPage.Settings;
      }
    }

    const locale = await getGuildLocale(vc.guildId);
    const owner = await vc.guild.members.fetch(channelData.ownerId).catch(() => null);
    const ownerTag = owner?.user.tag ?? i18n.t('tempvoice.err.owner_unknown', locale);

    if (currentPage === PanelPage.Main) {
      await msg.edit({
        embeds: [buildMainPageEmbed(
          ownerTag,
          vc.name,
          channelData.state,
          vc.members.size,
          vc.userLimit,
          vc.bitrate,
          locale,
        )],
      }).catch(() => null);
    } else if (currentPage === PanelPage.Access) {
      const trusted = await getTrusted(channelData.id);
      const blocked = await getBlocked(channelData.id);
      await msg.edit({
        embeds: [buildAccessPageEmbed(trusted, blocked, channelData.state, locale)],
      }).catch(() => null);
    } else if (currentPage === PanelPage.Settings) {
      await msg.edit({
        embeds: [buildSettingsPageEmbed(
          channelData.state,
          vc.rtcRegion ?? 'auto',
          vc.bitrate,
          locale,
        )],
      }).catch(() => null);
    }
  } catch (err) {
    log.error(`Ошибка авто-обновления панели для канала ${vc.id}`, { error: String(err) });
  }
}
