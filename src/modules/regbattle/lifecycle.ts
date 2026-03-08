// ═══════════════════════════════════════════════
//  RegBattle — Жизненный цикл каналов и ролей
//
//  1. Вход в мастер-канал → создание отряда
//  2. Вход/выход из отряда → ротация ролей
//  3. Пустой канал → удаление с задержкой
//  4. Восстановление при рестарте
//  5. Целостность ролей (периодическая проверка)
// ═══════════════════════════════════════════════

import {
  VoiceState,
  VoiceChannel,
  TextChannel,
  ChannelType,
  PermissionsBitField,
  GuildMember,
  Guild,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';

import {
  EMPTY_DELETE_DELAY_MS,
  ROLE_INTEGRITY_INTERVAL_MS,
} from './constants';

import {
  getConfig,
  getSquadByAnyVoice,
  getGuildSquads,
  getNextSquadNumber,
  createSquad,
  updateSquad,
  deleteSquad,
} from './database';

import {
  squadName,
  getSquadMemberCount,
  applySquadRoles,
  restoreSquadRoles,
  acquireCreationLock,
  releaseCreationLock,
  isCreationCooldown,
  setCreationCooldown,
} from './utils';

import {
  buildControlPanelEmbed,
  buildControlPanelButtons,
  buildSquadCreatedEmbed,
  buildSquadDisbandedEmbed,
} from './embeds';

import { recalculatePinger } from './pinger';

const log = logger.child('RegBattle:Lifecycle');

// Таймеры удаления пустых каналов
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Таймер проверки целостности ролей
let integrityTimer: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════
//  voiceStateUpdate — ядро системы
// ═══════════════════════════════════════════════

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: BublikClient,
): Promise<void> {
  try {
    // Вход в канал
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      await onJoinChannel(newState, client);
    }

    // Выход из канала
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await onLeaveChannel(oldState, client);
    }
  } catch (err) {
    log.error('Ошибка в voiceStateUpdate', { error: String(err) });
    errorReporter.eventError(err, 'voiceStateUpdate', 'regbattle');
  }
}

// ═══════════════════════════════════════════════
//  Вход в канал
// ═══════════════════════════════════════════════

async function onJoinChannel(state: VoiceState, client: BublikClient): Promise<void> {
  const channelId = state.channelId!;
  const member = state.member;
  if (!member || member.user.bot) return;

  const guildId = state.guild.id;
  const config = await getConfig(guildId);
  if (!config) return;

  // 1. Вход в мастер-канал → создать отряд
  if (config.masterChannelId && channelId === config.masterChannelId) {
    await handleMasterJoin(state, member, config, client);
    return;
  }

  // 2. Вход в существующий ПБ-канал → ротация ролей
  const squad = await getSquadByAnyVoice(channelId);
  if (squad) {
    // Отменить таймер удаления
    cancelDeleteTimer(squad.voiceChannelId);
    if (squad.airChannelId) cancelDeleteTimer(squad.airChannelId);

    // Ротация ролей
    log.debug(`Ротация ролей (вход в ПБ-канал): ${member.user.tag} → ping=${config.pingRoleId} squad=${config.inSquadRoleId}`);
    await applySquadRoles(member, config.pingRoleId, config.inSquadRoleId);

    // Обновить панель (счётчик)
    await updateControlPanel(squad, state.guild, client);

    // Уведомить пингер об изменении
    recalculatePinger(guildId);
  }
}

// ═══════════════════════════════════════════════
//  Вход в мастер-канал → создание отряда
// ═══════════════════════════════════════════════

async function handleMasterJoin(
  state: VoiceState,
  member: GuildMember,
  config: any,
  client: BublikClient,
): Promise<void> {
  // Проверка роли полевого командира
  const isCommander = config.commanderRoleIds.length === 0 ||
    config.commanderRoleIds.some((id: string) => member.roles.cache.has(id));

  if (!isCommander) {
    await member.voice.disconnect('Нет роли полевого командира').catch(() => null);
    return;
  }

  // Проверка: у пользователя уже есть активный отряд?
  const existingSquads = await getGuildSquads(state.guild.id);
  const alreadyOwns = existingSquads.find((s: any) => s.ownerId === member.id);
  if (alreadyOwns) {
    await member.voice.disconnect('У вас уже есть активный отряд').catch(() => null);
    log.info(`Отклонено: ${member.user.tag} уже владеет отрядом ${alreadyOwns.number}`);
    return;
  }

  // Антирейс: блокировка создания
  if (!acquireCreationLock(member.id)) return;

  try {
    if (isCreationCooldown(member.id)) {
      await member.voice.disconnect('Кулдаун создания отряда').catch(() => null);
      return;
    }

    const guildId = state.guild.id;
    const num = await getNextSquadNumber(guildId);
    const name = squadName(num);

    // Создать голосовой канал
    const vc = await state.guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: config.categoryId || undefined,
      userLimit: 0, // без лимита (до 99)
      permissionOverwrites: [
        {
          id: state.guild.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
          ],
        },
        {
          id: client.user!.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.MuteMembers,
            PermissionsBitField.Flags.MoveMembers,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.SendMessages,
          ],
        },
      ],
    });

    // Сохранить в БД
    const squad = await createSquad({
      guildId,
      number: num,
      voiceChannelId: vc.id,
      ownerId: member.id,
      configId: config.id,
    });

    // Переместить командира
    await member.voice.setChannel(vc, 'Создание отряда ПБ').catch(() => null);

    // Ротация ролей для командира
    log.debug(`Ротация ролей (командир): ${member.user.tag} → ping=${config.pingRoleId} squad=${config.inSquadRoleId}`);
    await applySquadRoles(member, config.pingRoleId, config.inSquadRoleId);

    setCreationCooldown(member.id);

    // Небольшая задержка для применения прав
    await new Promise((r) => setTimeout(r, 500));

    // Отправить панель управления в текстовый чат VC
    await sendControlPanel(vc, squad, member, config);

    // Объявление в пинг-канале
    if (config.announceChannelId) {
      try {
        const announceChannel = await client.channels.fetch(config.announceChannelId) as TextChannel;
        if (announceChannel) {
          const pingText = config.pingRoleId ? `<@&${config.pingRoleId}>` : '';
          await announceChannel.send({
            content: pingText || undefined,
            embeds: [buildSquadCreatedEmbed(num, member, vc.id)],
          });
        }
      } catch (err) {
        log.error('Не удалось отправить объявление', { error: String(err) });
      }
    }

    // Запустить пингер для этой гильдии
    recalculatePinger(guildId);

    log.info(`Отряд ${num} создан: ${vc.id} командир ${member.user.tag}`);
  } catch (err) {
    log.error(`Ошибка создания отряда для ${member.user.tag}`, { error: String(err) });
    errorReporter.moduleError(err, 'regbattle', `Создание отряда для ${member.user.tag}`);
  } finally {
    releaseCreationLock(member.id);
  }
}

// ═══════════════════════════════════════════════
//  Панель управления
// ═══════════════════════════════════════════════

async function sendControlPanel(
  vc: VoiceChannel,
  squad: any,
  owner: GuildMember,
  config: any,
): Promise<void> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const count = getSquadMemberCount(owner.guild, squad.voiceChannelId, squad.airChannelId);
      const embed = buildControlPanelEmbed(
        squad.number,
        owner.user.tag,
        count,
        config.squadSize,
        !!squad.airChannelId,
      );
      const buttons = buildControlPanelButtons(squad.id, !!squad.airChannelId);

      const msg = await vc.send({
        embeds: [embed],
        components: buttons,
      });

      await updateSquad(squad.id, { panelMessageId: msg.id });
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        log.warn(`Не удалось отправить панель ПБ в ${vc.id} после ${maxRetries} попыток`, { error: String(err) });
      }
    }
  }
}

/**
 * Обновить панель управления отрядом (числа, кнопки)
 */
export async function updateControlPanel(squad: any, guild: Guild, client: BublikClient): Promise<void> {
  if (!squad.panelMessageId) return;

  try {
    const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
    if (!vc) return;

    const count = getSquadMemberCount(guild, squad.voiceChannelId, squad.airChannelId);
    const owner = await guild.members.fetch(squad.ownerId).catch(() => null);

    const embed = buildControlPanelEmbed(
      squad.number,
      owner?.user.tag ?? 'Неизвестный',
      count,
      squad.config.squadSize,
      !!squad.airChannelId,
    );
    const buttons = buildControlPanelButtons(squad.id, !!squad.airChannelId);

    const msg = await vc.messages.fetch(squad.panelMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: buttons });
    }
  } catch {
    // Панель недоступна — не критично
  }
}

// ═══════════════════════════════════════════════
//  Выход из канала
// ═══════════════════════════════════════════════

async function onLeaveChannel(state: VoiceState, client: BublikClient): Promise<void> {
  const channelId = state.channelId!;
  const member = state.member;
  if (!member || member.user.bot) return;

  const squad = await getSquadByAnyVoice(channelId);
  if (!squad) return;

  const config = squad.config;

  // Проверить: участник НЕ перешёл в другой ПБ-канал этого же отряда
  const newChannelId = state.guild.members.cache.get(member.id)?.voice.channelId;
  const isStillInSquad =
    newChannelId === squad.voiceChannelId ||
    (squad.airChannelId && newChannelId === squad.airChannelId);

  if (!isStillInSquad) {
    // Проверить: может он перешёл в другой отряд
    const otherSquad = newChannelId ? await getSquadByAnyVoice(newChannelId) : null;
    if (!otherSquad) {
      // Полностью покинул ПБ → восстановить роли
      log.debug(`Восстановление ролей (выход из ПБ): ${member.user.tag} → ping=${config.pingRoleId} squad=${config.inSquadRoleId}`);
      await restoreSquadRoles(member, config.pingRoleId, config.inSquadRoleId);
    }
    // Если перешёл в другой отряд — роли сохраняются (inSquadRole)
  }

  // Обновить панель
  await updateControlPanel(squad, state.guild, client);
  recalculatePinger(state.guild.id);

  // Проверить пустоту основного канала
  const mainVc = state.guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  const mainEmpty = !mainVc || mainVc.members.filter((m) => !m.user.bot).size === 0;

  const airVc = squad.airChannelId
    ? (state.guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
    : null;
  const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;

  // Оба пустые → запланировать удаление
  if (mainEmpty && airEmpty) {
    scheduleSquadDeletion(squad, state.guild, client);
  }
}

// ═══════════════════════════════════════════════
//  Удаление пустого отряда
// ═══════════════════════════════════════════════

function cancelDeleteTimer(channelId: string): void {
  const timer = deleteTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    deleteTimers.delete(channelId);
  }
}

function scheduleSquadDeletion(squad: any, guild: Guild, client: BublikClient): void {
  // Не дублировать таймер
  if (deleteTimers.has(squad.voiceChannelId)) return;

  const timer = setTimeout(async () => {
    deleteTimers.delete(squad.voiceChannelId);

    // Перепроверить: всё ещё пусто?
    const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
    const mainEmpty = !mainVc || mainVc.members.filter((m) => !m.user.bot).size === 0;

    const airVc = squad.airChannelId
      ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
      : null;
    const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;

    if (!mainEmpty || !airEmpty) return; // Кто-то зашёл

    // Удалить каналы
    if (airVc) await airVc.delete('ПБ: отряд расформирован').catch(() => null);
    if (mainVc) await mainVc.delete('ПБ: отряд расформирован').catch(() => null);

    const squadNumber = squad.number;
    await deleteSquad(squad.id);

    // Объявление
    if (squad.config.announceChannelId) {
      try {
        const ch = await client.channels.fetch(squad.config.announceChannelId) as TextChannel;
        if (ch) {
          await ch.send({ embeds: [buildSquadDisbandedEmbed(squadNumber)] });
        }
      } catch { /* skip */ }
    }

    recalculatePinger(guild.id);
    log.info(`Отряд ${squadNumber} расформирован (пустой): ${squad.voiceChannelId}`);
  }, EMPTY_DELETE_DELAY_MS);

  deleteTimers.set(squad.voiceChannelId, timer);
}

// ═══════════════════════════════════════════════
//  Восстановление при рестарте
// ═══════════════════════════════════════════════

export async function restoreSquads(client: BublikClient): Promise<void> {
  try {
    for (const [, guild] of client.guilds.cache) {
      const config = await getConfig(guild.id);
      if (!config) continue;

      const squads = await getGuildSquads(guild.id);

      for (const squad of squads) {
        const vc = guild.channels.cache.get(squad.voiceChannelId);

        if (!vc) {
          // Канал не существует → удалить запись
          if (squad.airChannelId) {
            const air = guild.channels.cache.get(squad.airChannelId);
            if (air) await air.delete('ПБ: главный канал недоступен').catch(() => null);
          }
          await deleteSquad(squad.id);
          log.debug(`Cleanup: удалена запись отряда для несуществующего канала ${squad.voiceChannelId}`);
          continue;
        }

        // Проверить авиа-канал
        if (squad.airChannelId) {
          const airVc = guild.channels.cache.get(squad.airChannelId);
          if (!airVc) {
            await updateSquad(squad.id, { airChannelId: null });
            log.debug(`Cleanup: авиа-канал ${squad.airChannelId} не найден`);
          }
        }

        // Если пуст → планировать удаление
        if (vc.type === ChannelType.GuildVoice) {
          const mainEmpty = (vc as VoiceChannel).members.filter((m) => !m.user.bot).size === 0;
          const airVc = squad.airChannelId
            ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
            : null;
          const airEmpty = !airVc || airVc.members.filter((m) => !m.user.bot).size === 0;

          if (mainEmpty && airEmpty) {
            scheduleSquadDeletion(squad, guild, client);
          } else {
            // Проверить роли у всех участников в каналах
            const mainMembers = (vc as VoiceChannel).members.filter((m) => !m.user.bot);
            for (const [, m] of mainMembers) {
              await applySquadRoles(m, config.pingRoleId, config.inSquadRoleId);
            }
            if (airVc && airVc.type === ChannelType.GuildVoice) {
              const airMembers = (airVc as VoiceChannel).members.filter((m) => !m.user.bot);
              for (const [, m] of airMembers) {
                await applySquadRoles(m, config.pingRoleId, config.inSquadRoleId);
              }
            }
          }
        }
      }

      // Рассчитать пингер
      recalculatePinger(guild.id);
    }

    log.info('Отряды ПБ восстановлены');
  } catch (err) {
    log.error('Ошибка восстановления отрядов ПБ', { error: String(err) });
  }
}

// ═══════════════════════════════════════════════
//  Целостность ролей — периодическая проверка
// ═══════════════════════════════════════════════

export function startRoleIntegrityChecker(client: BublikClient): void {
  if (integrityTimer) return;

  integrityTimer = setInterval(async () => {
    try {
      await checkRoleIntegrity(client);
    } catch (err) {
      log.error('Ошибка проверки целостности ролей', { error: String(err) });
    }
  }, ROLE_INTEGRITY_INTERVAL_MS);
}

export function stopRoleIntegrityChecker(): void {
  if (integrityTimer) {
    clearInterval(integrityTimer);
    integrityTimer = null;
  }

  // Отменить все таймеры удаления
  for (const timer of deleteTimers.values()) {
    clearTimeout(timer);
  }
  deleteTimers.clear();
}

/**
 * Проверка целостности ролей:
 * 1. Каждому в ПБ-войсе — выдать inSquadRole, снять pingRole
 * 2. Каждому с inSquadRole НЕ в ПБ-войсе — вернуть pingRole, снять inSquadRole
 *
 * Используем VoiceChannel.members (авторитетный источник кто в канале),
 * а НЕ member.voice.channelId из guild.members.cache (может быть stale).
 */
async function checkRoleIntegrity(client: BublikClient): Promise<void> {
  for (const [, guild] of client.guilds.cache) {
    const config = await getConfig(guild.id);
    if (!config || !config.inSquadRoleId || !config.pingRoleId) continue;

    const squads = await getGuildSquads(guild.id);

    // Собрать ID всех, кто СЕЙЧАС в ПБ-войсах (из VoiceChannel.members)
    const membersInPb = new Set<string>();

    for (const squad of squads) {
      const mainVc = guild.channels.cache.get(squad.voiceChannelId);
      if (mainVc && mainVc.type === ChannelType.GuildVoice) {
        (mainVc as VoiceChannel).members.forEach((m) => {
          if (!m.user.bot) membersInPb.add(m.id);
        });
      }

      if (squad.airChannelId) {
        const airVc = guild.channels.cache.get(squad.airChannelId);
        if (airVc && airVc.type === ChannelType.GuildVoice) {
          (airVc as VoiceChannel).members.forEach((m) => {
            if (!m.user.bot) membersInPb.add(m.id);
          });
        }
      }
    }

    // ПОЗИТИВ: каждому в ПБ-войсе → правильные роли
    for (const memberId of membersInPb) {
      const member = guild.members.cache.get(memberId);
      if (!member) continue;

      const needsApply =
        (config.pingRoleId && member.roles.cache.has(config.pingRoleId)) ||
        (config.inSquadRoleId && !member.roles.cache.has(config.inSquadRoleId));

      if (needsApply) {
        await applySquadRoles(member, config.pingRoleId, config.inSquadRoleId);
        log.info(`Integrity ✔: ${member.user.tag} — выданы роли ПБ (находится в войсе)`);
      }
    }

    // НЕГАТИВ: у кого inSquadRole, но нет в ПБ-войсе → восстановить
    const inSquadRole = guild.roles.cache.get(config.inSquadRoleId);
    if (!inSquadRole) continue;

    for (const [, member] of inSquadRole.members) {
      if (member.user.bot) continue;

      if (!membersInPb.has(member.id)) {
        await restoreSquadRoles(member, config.pingRoleId, config.inSquadRoleId);
        log.info(`Integrity ✖: ${member.user.tag} — убраны роли ПБ (не в войсе)`);
      }
    }
  }
}
