// ═══════════════════════════════════════════════
//  RegBattle — Обработчики интеракций
//
//  Кнопки панели управления отрядом:
//  1. РАСПОРЯЖЕНИЯ — мьют на 30 сек
//  2. КИК — выбор + отключение из войса
//  3. МЬЮТ — toggle мьюта отдельного бойца
//  4. ПИНГ В ЛС — рассылка DM + отчёт
//  5. АВИАЦИЯ — создание авиа-канала
//  6. ПЕРЕДАТЬ ПРАВА — передача командования
//  7. ВЫГОВОР — дисциплинарная система (4 шага)
// ═══════════════════════════════════════════════

import {
  Interaction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildMember,
  VoiceChannel,
  ChannelType,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { getRedis } from '../../core/Redis';

import {
  RB_PREFIX,
  RB_SEP,
  ORDERS_MUTE_DURATION_MS,
  DM_PING_COOLDOWN_MS,
  DM_SEND_DELAY_MS,
} from './constants';

import {
  getSquad,
  updateSquad,
  getConfig,
  getAllPbChannelIds,
  createReprimand,
  getReprimand,
  updateReprimand,
} from './database';

import {
  airName,
  getSquadMembers,
} from './utils';

import {
  buildKickSelect,
  buildTransferSelect,
  buildMuteToggleSelect,
  buildReprimandUserSelect,
  buildReprimandTypeSelect,
  buildOrdersActiveEmbed,
  buildOrdersEndedEmbed,
  buildDmPingEmbed,
  buildDmPingReport,
  buildControlPanelButtons,
  rbSuccess,
  rbError,
  rbWarn,
} from './embeds';

import { updateControlPanel } from './lifecycle';
import { recalculatePinger } from './pinger';

const log = logger.child('RegBattle:Handlers');

// Активные мьюты (squadId → timeout). Для предотвращения дублирования.
const activeMutes = new Map<string, ReturnType<typeof setTimeout>>();

// ═══════════════════════════════════════════════
//  Роутер интеракций
// ═══════════════════════════════════════════════

export async function handleRegBattleInteraction(
  interaction: Interaction,
  client: BublikClient,
): Promise<void> {
  try {
    // ── Кнопки ──────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX) return;

      const action = parts[1];
      const squadId = parts[2];

      switch (action) {
        case 'orders':
          await handleOrders(interaction, squadId, client);
          break;
        case 'kick':
          await handleKick(interaction, squadId, client);
          break;
        case 'mutetoggle':
          await handleMuteToggle(interaction, squadId, client);
          break;
        case 'dmping':
          await handleDmPing(interaction, squadId, client);
          break;
        case 'aviation':
          await handleAviation(interaction, squadId, client);
          break;
        case 'transfer':
          await handleTransfer(interaction, squadId, client);
          break;
        case 'reprimand':
          await handleReprimand(interaction, squadId, client);
          break;
        case 'rep_appeal':
          await handleReprimandAppeal(interaction, squadId, client);
          break;
        case 'rep_annul':
          await handleReprimandAnnul(interaction, squadId, client);
          break;
      }
      return;
    }

    // ── StringSelectMenu ────────────
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX || parts[1] !== 'sel') return;

      const selType = parts[2];
      const squadId = parts[3];

      switch (selType) {
        case 'kick':
          await handleKickSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'transfer':
          await handleTransferSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'mutetoggle':
          await handleMuteToggleSelect(interaction as StringSelectMenuInteraction, squadId, client);
          break;
        case 'rep_type': {
          // customId: rb:sel:rep_type:squadId:offenderId
          const offenderId = parts[4];
          await handleReprimandTypeSelect(interaction as StringSelectMenuInteraction, squadId, offenderId, client);
          break;
        }
      }
      return;
    }

    // ── UserSelectMenu ──────────────
    if (interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX || parts[1] !== 'sel') return;

      const selType = parts[2];
      const squadId = parts[3];

      if (selType === 'rep_user') {
        await handleReprimandUserSelect(interaction as UserSelectMenuInteraction, squadId, client);
      }
      return;
    }

    // ── ModalSubmit ─────────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(RB_SEP);
      if (parts[0] !== RB_PREFIX) return;

      if (parts[1] === 'rep_modal') {
        // customId: rb:rep_modal:squadId:offenderId:typeRoleId
        const squadId = parts[2];
        const offenderId = parts[3];
        const typeRoleId = parts[4];
        await handleReprimandModal(interaction as ModalSubmitInteraction, squadId, offenderId, typeRoleId, client);
      }
      return;
    }
  } catch (err) {
    log.error('Ошибка в обработчике regbattle', { error: String(err) });
    errorReporter.eventError(err, 'interactionCreate', 'regbattle');

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [rbError('Произошла внутренняя ошибка.')],
        ephemeral: true,
      }).catch(() => null);
    }
  }
}

// ═══════════════════════════════════════════════
//  Проверка владельца
// ═══════════════════════════════════════════════

async function checkOwner(interaction: ButtonInteraction | StringSelectMenuInteraction, squadId: string): Promise<any | null> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return null;
  }

  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир отряда может использовать эту кнопку.')], ephemeral: true });
    return null;
  }

  return squad;
}

// ═══════════════════════════════════════════════
//  📢 РАСПОРЯЖЕНИЯ — мьют на 30 сек
// ═══════════════════════════════════════════════

async function handleOrders(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  // Уже идёт мьют?
  if (activeMutes.has(squadId)) {
    await interaction.reply({ embeds: [rbWarn('Распоряжения уже активны. Подождите завершения.')], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;

  // Собрать участников из основного + авиа канала
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);
  const toMute: GuildMember[] = [];

  for (const member of members) {
    if (member.id === squad.ownerId) continue; // Командир не мьютится

    // muteRoleIds — список ролей-исключений (например офицеры, которые НЕ мьютятся)
    // Если muteRoleIds пуст — мьютятся все кроме командира
    // Если muteRoleIds задан — НЕ мьютятся те, у кого есть одна из этих ролей
    if (config.muteRoleIds.length > 0) {
      const isExempt = config.muteRoleIds.some((id: string) => member.roles.cache.has(id));
      if (isExempt) continue;
    }

    toMute.push(member);
  }

  // Замьютить
  const muted: GuildMember[] = [];
  for (const member of toMute) {
    try {
      if (!member.voice.serverMute) {
        await member.voice.setMute(true, 'ПБ: Распоряжения командира');
        muted.push(member);
      }
    } catch { /* нет прав мьютить — пропуск */ }
  }

  // Уведомить в канале
  const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  let notifMsg: any = null;
  if (vc) {
    notifMsg = await vc.send({ embeds: [buildOrdersActiveEmbed(30)] }).catch(() => null);
  }

  await interaction.editReply({
    embeds: [rbSuccess(`Распоряжения активны! Замьючено **${muted.length}** бойцов на 30 сек.`)],
  });

  // Таймер размьюта
  const timeout = setTimeout(async () => {
    activeMutes.delete(squadId);

    for (const member of muted) {
      try {
        // Перепроверить: ещё в войсе?
        const fresh = guild.members.cache.get(member.id);
        if (fresh?.voice.channelId && fresh.voice.serverMute) {
          await fresh.voice.setMute(false, 'ПБ: Конец распоряжений');
        }
      } catch { /* пропуск */ }
    }

    // Обновить уведомление
    if (notifMsg) {
      try {
        await notifMsg.edit({ embeds: [buildOrdersEndedEmbed()] });
      } catch { /* skip */ }
    }
  }, ORDERS_MUTE_DURATION_MS);

  activeMutes.set(squadId, timeout);
}

// ═══════════════════════════════════════════════
//  👢 КИК — выбор участника
// ═══════════════════════════════════════════════

async function handleKick(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить владельца из списка
  const kickable = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({ id: m.id, displayName: m.displayName }));

  if (kickable.length === 0) {
    await interaction.reply({ embeds: [rbWarn('Нет бойцов для кика.')], ephemeral: true });
    return;
  }

  // Ограничить до 25 (лимит SelectMenu)
  const limited = kickable.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn('Выберите бойца для отключения из голосового канала:')],
    components: [buildKickSelect(squadId, limited)],
    ephemeral: true,
  });
}

async function handleKickSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир может выполнять кик.')], ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetId).catch(() => null);

  if (!member || !member.voice.channelId) {
    await interaction.update({ embeds: [rbWarn('Боец уже вышел из канала.')], components: [] });
    return;
  }

  await member.voice.disconnect('ПБ: кик командиром').catch(() => null);

  await interaction.update({
    embeds: [rbSuccess(`${member.displayName} отключён из голосового канала.`)],
    components: [],
  });

  log.info(`Кик из ПБ: ${member.user.tag} командиром ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  🔇 МЬЮТ — toggle мьюта отдельного бойца
// ═══════════════════════════════════════════════

async function handleMuteToggle(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить командира
  const muteable = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      muted: !!m.voice.serverMute,
    }));

  if (muteable.length === 0) {
    await interaction.reply({ embeds: [rbWarn('Нет бойцов для мьюта.')], ephemeral: true });
    return;
  }

  const limited = muteable.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn('Выберите бойца для мьюта/размьюта микрофона:')],
    components: [buildMuteToggleSelect(squadId, limited)],
    ephemeral: true,
  });
}

async function handleMuteToggleSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир может мьютить бойцов.')], ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild!;
  const member = await guild.members.fetch(targetId).catch(() => null);

  if (!member || !member.voice.channelId) {
    await interaction.update({ embeds: [rbWarn('Боец уже вышел из канала.')], components: [] });
    return;
  }

  const wasMuted = member.voice.serverMute;

  try {
    await member.voice.setMute(!wasMuted, `ПБ: ${wasMuted ? 'размьют' : 'мьют'} командиром`);

    await interaction.update({
      embeds: [rbSuccess(
        wasMuted
          ? `🔊 **${member.displayName}** размьючен.`
          : `🔇 **${member.displayName}** замьючен.`,
      )],
      components: [],
    });

    log.info(`Мьют-toggle ПБ: ${member.user.tag} → ${wasMuted ? 'unmuted' : 'muted'} (командир ${interaction.user.tag})`);
  } catch {
    await interaction.update({
      embeds: [rbError('Не удалось изменить состояние мьюта. Проверьте права бота.')],
      components: [],
    });
  }
}

// ═══════════════════════════════════════════════
//  📩 ПИНГ В ЛС — рассылка DM
// ═══════════════════════════════════════════════

async function handleDmPing(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  // Кулдаун (Redis)
  const r = getRedis();
  const cooldownKey = `rb:dmcd:${squadId}`;
  const cooldown = await r.get(cooldownKey);
  if (cooldown) {
    const leftSec = Math.ceil((parseInt(cooldown, 10) - Date.now()) / 1000);
    await interaction.reply({
      embeds: [rbWarn(`Кулдаун рассылки: **${Math.max(leftSec, 1)} сек.** Попробуйте позже.`)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;

  if (!config.pingRoleId) {
    await interaction.editReply({ embeds: [rbError('Пинг-роль не настроена.')] });
    return;
  }

  // Получить всех с pingRoleId
  const role = guild.roles.cache.get(config.pingRoleId);
  if (!role) {
    await interaction.editReply({ embeds: [rbError('Пинг-роль не найдена на сервере.')] });
    return;
  }

  // Получить список всех ПБ-каналов, чтобы исключить тех кто уже в отряде
  const pbChannelIds = await getAllPbChannelIds(guild.id);

  // Фильтр: не бот, НЕ в ПБ-войсе, НЕ играл сегодня
  const targets = role.members.filter((m) => {
    if (m.user.bot) return false;
    const voiceId = m.voice.channelId;
    // Исключить тех, кто уже в ПБ-войсе
    if (voiceId && pbChannelIds.includes(voiceId)) return false;
    // Исключить тех, кто играл сегодня
    if (config.playedTodayRoleId && m.roles.cache.has(config.playedTodayRoleId)) return false;
    return true;
  });
  if (targets.size === 0) {
    await interaction.editReply({ embeds: [rbWarn('Нет доступных бойцов с пинг-ролью.')] });
    return;
  }

  // Установить кулдаун сразу
  const expireAt = Date.now() + DM_PING_COOLDOWN_MS;
  await r.setex(cooldownKey, Math.ceil(DM_PING_COOLDOWN_MS / 1000), String(expireAt));

  // Рассылка с задержкой
  const delivered: string[] = [];
  const failed: string[] = [];

  for (const [, member] of targets) {
    try {
      await member.send({
        embeds: [buildDmPingEmbed(
          squad.number,
          interaction.user.tag,
          squad.voiceChannelId,
          guild.name,
        )],
      });
      delivered.push(member.user.tag);
    } catch {
      failed.push(member.user.tag);
    }

    // Задержка между DM (антиспам)
    await new Promise((resolve) => setTimeout(resolve, DM_SEND_DELAY_MS));
  }

  await interaction.editReply({
    embeds: [buildDmPingReport(delivered, failed)],
  });

  log.info(`DM-пинг ПБ: ${delivered.length} доставлено, ${failed.length} неудач (командир ${interaction.user.tag})`);
}

// ═══════════════════════════════════════════════
//  ✈️ АВИАЦИЯ — создание авиа-канала
// ═══════════════════════════════════════════════

async function handleAviation(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  if (squad.airChannelId) {
    await interaction.reply({ embeds: [rbWarn('Авиационный канал уже создан.')], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = squad.config;
  const name = airName(squad.number);

  // Получить категорию основного канала
  const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  const parentId = mainVc?.parentId || config.categoryId;

  try {
    const airVc = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId || undefined,
      userLimit: config.airSize,
      permissionOverwrites: [
        {
          id: guild.id,
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
          ],
        },
      ],
    });

    // Обновить БД
    const updated = await updateSquad(squad.id, { airChannelId: airVc.id });

    // Обновить панель (кнопка авиации становится disabled)
    await updateControlPanel(updated, guild, client);

    await interaction.editReply({
      embeds: [rbSuccess(`Авиационный канал **${name}** создан! (макс. ${config.airSize} чел.)\n<#${airVc.id}>`)],
    });

    recalculatePinger(guild.id);
    log.info(`Авиа-канал создан: ${name} (${airVc.id}) для отряда ${squad.number}`);
  } catch (err) {
    log.error('Ошибка создания авиа-канала', { error: String(err) });
    await interaction.editReply({ embeds: [rbError('Не удалось создать авиа-канал.')] });
  }
}

// ═══════════════════════════════════════════════
//  🔄 ПЕРЕДАТЬ ПРАВА — выбор нового командира
// ═══════════════════════════════════════════════

async function handleTransfer(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  const guild = interaction.guild!;
  const members = getSquadMembers(guild, squad.voiceChannelId, squad.airChannelId);

  // Исключить текущего владельца
  const candidates = members
    .filter((m) => m.id !== squad.ownerId)
    .map((m) => ({ id: m.id, displayName: m.displayName }));

  if (candidates.length === 0) {
    await interaction.reply({ embeds: [rbWarn('Нет бойцов для передачи прав.')], ephemeral: true });
    return;
  }

  const limited = candidates.slice(0, 25);

  await interaction.reply({
    embeds: [rbWarn('Выберите нового командира отряда:')],
    components: [buildTransferSelect(squadId, limited)],
    ephemeral: true,
  });
}

async function handleTransferSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только текущий командир может передать права.')], ephemeral: true });
    return;
  }

  const newOwnerId = interaction.values[0];
  const guild = interaction.guild!;
  const newOwner = await guild.members.fetch(newOwnerId).catch(() => null);

  if (!newOwner) {
    await interaction.update({ embeds: [rbError('Пользователь не найден.')], components: [] });
    return;
  }

  // Проверить: новый командир всё ещё в этом отряде?
  const voiceId = newOwner.voice.channelId;
  const isInSquad = voiceId === squad.voiceChannelId || (squad.airChannelId && voiceId === squad.airChannelId);
  if (!isInSquad) {
    await interaction.update({ embeds: [rbError('Боец уже покинул голосовой канал отряда.')], components: [] });
    return;
  }

  // Обновить владельца
  const updated = await updateSquad(squad.id, { ownerId: newOwnerId });

  // Обновить панель
  await updateControlPanel(updated, guild, client);

  await interaction.update({
    embeds: [rbSuccess(`Командование передано **${newOwner.displayName}**!`)],
    components: [],
  });

  // Уведомить нового командира
  const vc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
  if (vc) {
    await vc.send({
      content: `${newOwner.toString()}`,
      embeds: [rbSuccess(`Вы назначены командиром **ОТРЯДА ${squad.number}**! Используйте панель управления выше.`)],
    }).catch(() => null);
  }

  log.info(`Передача прав ПБ: отряд ${squad.number} — ${interaction.user.tag} → ${newOwner.user.tag}`);
}

// ═══════════════════════════════════════════════
//  ⚠️ ВЫГОВОР — дисциплинарная система
// ═══════════════════════════════════════════════

/**
 * Шаг 1: Кнопка ВЫГОВОР → UserSelect (поиск по серверу)
 */
async function handleReprimand(
  interaction: ButtonInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await checkOwner(interaction, squadId);
  if (!squad) return;

  const config = squad.config;

  if (!config.reprimandChannelId) {
    await interaction.reply({
      embeds: [rbError('Канал для выговоров не настроен. Используйте `/regbattle setup reprimand_channel`.')],
      ephemeral: true,
    });
    return;
  }

  if (config.reprimandTypeRoleIds.length === 0) {
    await interaction.reply({
      embeds: [rbError('Типы выговоров не настроены. Используйте `/regbattle addrole type:reprimand_type`.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [rbWarn('**Дисциплинарное взыскание**\n\nВыберите нарушителя:')],
    components: [buildReprimandUserSelect(squadId)],
    ephemeral: true,
  });
}

/**
 * Шаг 2: UserSelect → пользователь выбран → показать типы выговоров
 */
async function handleReprimandUserSelect(
  interaction: UserSelectMenuInteraction,
  squadId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир может выдавать выговоры.')], ephemeral: true });
    return;
  }

  const offenderId = interaction.values[0];
  const guild = interaction.guild!;
  const offender = await guild.members.fetch(offenderId).catch(() => null);

  if (!offender) {
    await interaction.update({ embeds: [rbError('Пользователь не найден на сервере.')], components: [] });
    return;
  }

  if (offender.user.bot) {
    await interaction.update({ embeds: [rbError('Нельзя выдать выговор боту.')], components: [] });
    return;
  }

  const config = squad.config;

  // Собрать роли-типы выговоров
  const types: { roleId: string; roleName: string }[] = [];
  for (const roleId of config.reprimandTypeRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (role) types.push({ roleId: role.id, roleName: role.name });
  }

  if (types.length === 0) {
    await interaction.update({ embeds: [rbError('Нет доступных типов выговоров.')], components: [] });
    return;
  }

  await interaction.update({
    embeds: [rbWarn(
      `**Дисциплинарное взыскание**\n\n` +
      `Нарушитель: ${offender.toString()}\n` +
      `Выберите тип выговора:`,
    )],
    components: [buildReprimandTypeSelect(squadId, offenderId, types)],
  });
}

/**
 * Шаг 3: Тип выбран → модальное окно для причины
 */
async function handleReprimandTypeSelect(
  interaction: StringSelectMenuInteraction,
  squadId: string,
  offenderId: string,
  client: BublikClient,
): Promise<void> {
  const squad = await getSquad(squadId);
  if (!squad) {
    await interaction.reply({ embeds: [rbError('Отряд не найден.')], ephemeral: true });
    return;
  }
  if (squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир может выдавать выговоры.')], ephemeral: true });
    return;
  }

  const typeRoleId = interaction.values[0];

  // Показать модальное окно для причины
  const modal = new ModalBuilder()
    .setCustomId(`${RB_PREFIX}${RB_SEP}rep_modal${RB_SEP}${squadId}${RB_SEP}${offenderId}${RB_SEP}${typeRoleId}`)
    .setTitle('Причина выговора');

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Укажите причину выговора')
    .setPlaceholder('Опишите нарушение...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
  );

  await interaction.showModal(modal);
}

/**
 * Шаг 4: Модальное окно → создание выговора + отправка эмбеда
 */
async function handleReprimandModal(
  interaction: ModalSubmitInteraction,
  squadId: string,
  offenderId: string,
  typeRoleId: string,
  client: BublikClient,
): Promise<void> {
  const guild = interaction.guild!;
  const reason = interaction.fields.getTextInputValue('reason');

  // Проверить, что инициатор — командир отряда
  const squad = await getSquad(squadId);
  if (!squad || squad.ownerId !== interaction.user.id) {
    await interaction.reply({ embeds: [rbError('Только командир отряда может выдавать выговоры.')], ephemeral: true });
    return;
  }

  // Получить конфиг
  const config = await getConfig(guild.id);
  if (!config || !config.reprimandChannelId) {
    await interaction.reply({ embeds: [rbError('Канал для выговоров не настроен.')], ephemeral: true });
    return;
  }

  const offender = await guild.members.fetch(offenderId).catch(() => null);
  if (!offender) {
    await interaction.reply({ embeds: [rbError('Нарушитель не найден на сервере.')], ephemeral: true });
    return;
  }

  const typeRole = guild.roles.cache.get(typeRoleId);
  const typeName = typeRole?.name ?? 'Неизвестный тип';

  await interaction.deferReply({ ephemeral: true });

  // Выдать роль-тип выговора нарушителю
  if (typeRole) {
    try {
      await offender.roles.add(typeRoleId, `Выговор: ${reason.slice(0, 100)}`);
    } catch (err) {
      log.warn(`Не удалось выдать роль выговора ${typeName} для ${offender.user.tag}`, { error: String(err) });
    }
  }

  // Создать запись в БД
  const reprimand = await createReprimand({
    guildId: guild.id,
    offenderId,
    issuerId: interaction.user.id,
    typeRoleId,
    reason,
    channelId: config.reprimandChannelId,
  });

  // Отправить эмбед в канал выговоров
  const repChannel = await guild.channels.fetch(config.reprimandChannelId).catch(() => null);
  if (!repChannel || !repChannel.isTextBased()) {
    await interaction.editReply({ embeds: [rbError('Канал для выговоров не найден.')] });
    return;
  }

  const embed = buildReprimandEmbed(
    offender,
    interaction.user,
    typeName,
    reason,
    reprimand.id,
    reprimand.createdAt,
  );

  const buttons = buildReprimandButtons(reprimand.id);

  const msg = await (repChannel as any).send({
    content: `${offender.toString()}`,
    embeds: [embed],
    components: buttons,
  });

  // Сохранить messageId
  await updateReprimand(reprimand.id, { messageId: msg.id });

  await interaction.editReply({
    embeds: [rbSuccess(
      `Выговор выдан **${offender.displayName}**.\n` +
      `> Тип: **${typeName}**\n` +
      `> Причина: ${reason.slice(0, 200)}`,
    )],
  });

  log.info(`Выговор: ${offender.user.tag} — ${typeName} — от ${interaction.user.tag} (${reprimand.id})`);
}

// ═══════════════════════════════════════════════
//  Выговор — кнопки (аппеляция / аннуляция)
// ═══════════════════════════════════════════════

/**
 * Кнопка «Не согласен» — апелляция (только нарушитель)
 */
async function handleReprimandAppeal(
  interaction: ButtonInteraction,
  reprimandId: string,
  client: BublikClient,
): Promise<void> {
  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError('Выговор не найден.')], ephemeral: true });
    return;
  }

  if (interaction.user.id !== reprimand.offenderId) {
    await interaction.reply({ embeds: [rbError('Подать апелляцию может только нарушитель.')], ephemeral: true });
    return;
  }

  if (reprimand.status === 'appealing') {
    await interaction.reply({ embeds: [rbWarn('Апелляция уже подана. Используйте созданные каналы.')], ephemeral: true });
    return;
  }

  if (reprimand.status === 'annulled') {
    await interaction.reply({ embeds: [rbWarn('Этот выговор уже аннулирован.')], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от дабл-клика
  const lockKey = `rb:appeal:lock:${reprimandId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [rbWarn('Апелляция уже обрабатывается. Подождите.')] });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await getRedis().del(lockKey);
    await interaction.editReply({ embeds: [rbError('Конфигурация ПБ не найдена.')] });
    return;
  }

  // Создать категорию для апелляции
  const categoryName = `📋 Апелляция #${reprimand.id.slice(-6)}`;

  // Разрешения: нарушитель + выдавший + annulRoleIds + бот
  const permissionOverwrites: any[] = [
    // Запретить всем по умолчанию
    {
      id: guild.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    // Бот
    {
      id: client.user!.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MuteMembers,
      ],
    },
    // Нарушитель
    {
      id: reprimand.offenderId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    // Выдавший выговор
    {
      id: reprimand.issuerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  // Роли-аннуляторы
  for (const roleId of config.reprimandAnnulRoleIds) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    });
  }

  try {
    const category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites,
    });

    const textChannel = await guild.channels.create({
      name: '💬-обсуждение',
      type: ChannelType.GuildText,
      parent: category.id,
    });

    const voiceChannel = await guild.channels.create({
      name: '🔊 Слушание',
      type: ChannelType.GuildVoice,
      parent: category.id,
    });

    // Обновить запись
    await updateReprimand(reprimand.id, {
      status: 'appealing',
      appealCategoryId: category.id,
      appealTextId: textChannel.id,
      appealVoiceId: voiceChannel.id,
    });

    // Отправить информацию в текстовый канал апелляции
    const typeRole = guild.roles.cache.get(reprimand.typeRoleId);
    const issuer = await guild.members.fetch(reprimand.issuerId).catch(() => null);
    const offender = await guild.members.fetch(reprimand.offenderId).catch(() => null);

    const appealEmbed = buildAppealInfoEmbed(
      offender,
      issuer,
      typeRole?.name ?? 'Неизвестный тип',
      reprimand.reason,
      reprimand.id,
      reprimand.createdAt,
    );

    // Пинг всех причастных: нарушитель + выдавший + роли-аннуляторы
    const pings: string[] = [
      offender?.toString() ?? `<@${reprimand.offenderId}>`,
      issuer?.toString() ?? `<@${reprimand.issuerId}>`,
      ...config.reprimandAnnulRoleIds.map((id: string) => `<@&${id}>`),
    ];

    await textChannel.send({
      content: `${pings.join(' ')} — подана апелляция по выговору.`,
      embeds: [appealEmbed],
    });

    // Обновить оригинальное сообщение в канале выговоров
    await updateReprimandMessage(guild, reprimand, 'appealing', config);

    await interaction.editReply({
      embeds: [rbSuccess(
        `Апелляция принята.\n\n` +
        `> 💬 Текстовый: <#${textChannel.id}>\n` +
        `> 🔊 Голосовой: <#${voiceChannel.id}>\n\n` +
        `Используйте эти каналы для обсуждения.`,
      )],
    });

    log.info(`Апелляция: ${interaction.user.tag} по выговору ${reprimand.id}`);
  } catch (err) {
    log.error('Ошибка создания категории апелляции', { error: String(err) });
    await interaction.editReply({ embeds: [rbError('Не удалось создать каналы для апелляции.')] });
  }
}

/**
 * Кнопка «Аннулировать» — только для ролей из annulRoleIds
 */
async function handleReprimandAnnul(
  interaction: ButtonInteraction,
  reprimandId: string,
  client: BublikClient,
): Promise<void> {
  const reprimand = await getReprimand(reprimandId);
  if (!reprimand) {
    await interaction.reply({ embeds: [rbError('Выговор не найден.')], ephemeral: true });
    return;
  }

  if (reprimand.status === 'annulled') {
    await interaction.reply({ embeds: [rbWarn('Этот выговор уже аннулирован.')], ephemeral: true });
    return;
  }

  const guild = interaction.guild!;
  const config = await getConfig(guild.id);
  if (!config) {
    await interaction.reply({ embeds: [rbError('Конфигурация ПБ не найдена.')], ephemeral: true });
    return;
  }

  // Проверить права: пользователь должен иметь одну из annulRoleIds
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ embeds: [rbError('Не удалось получить данные пользователя.')], ephemeral: true });
    return;
  }

  const hasAnnulRole = config.reprimandAnnulRoleIds.some((id: string) => member.roles.cache.has(id));
  if (!hasAnnulRole) {
    await interaction.reply({
      embeds: [rbError('У вас нет прав для аннулирования выговоров.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Атомарная блокировка — защита от дабл-клика
  const lockKey = `rb:annul:lock:${reprimandId}`;
  const locked = await getRedis().set(lockKey, '1', 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [rbWarn('Аннуляция уже обрабатывается. Подождите.')] });
    return;
  }

  // Снять роль-тип выговора с нарушителя
  const offender = await guild.members.fetch(reprimand.offenderId).catch(() => null);
  if (offender) {
    try {
      await offender.roles.remove(reprimand.typeRoleId, 'Выговор аннулирован');
    } catch (err) {
      log.warn(`Не удалось снять роль выговора у ${offender.user.tag}`, { error: String(err) });
    }
  }

  // Обновить статус
  await updateReprimand(reprimand.id, {
    status: 'annulled',
    annulledById: interaction.user.id,
    annulledAt: new Date(),
  });

  // Обновить оригинальное сообщение
  await updateReprimandMessage(guild, reprimand, 'annulled', config, interaction.user.tag);

  // Удалить каналы апелляции (если есть)
  if (reprimand.appealCategoryId) {
    try {
      if (reprimand.appealTextId) {
        const textCh = guild.channels.cache.get(reprimand.appealTextId);
        if (textCh) await textCh.delete('Выговор аннулирован').catch(() => null);
      }
      if (reprimand.appealVoiceId) {
        const voiceCh = guild.channels.cache.get(reprimand.appealVoiceId);
        if (voiceCh) await voiceCh.delete('Выговор аннулирован').catch(() => null);
      }
      const category = guild.channels.cache.get(reprimand.appealCategoryId);
      if (category) await category.delete('Выговор аннулирован').catch(() => null);
    } catch {
      log.warn(`Не удалось удалить каналы апелляции для выговора ${reprimand.id}`);
    }
  }

  await interaction.editReply({
    embeds: [rbSuccess(`Выговор **#${reprimand.id.slice(-6)}** аннулирован.`)],
  });

  log.info(`Аннуляция выговора: ${reprimand.id} — аннулировал ${interaction.user.tag}`);
}

// ═══════════════════════════════════════════════
//  Выговор — вспомогательные функции
// ═══════════════════════════════════════════════

function buildReprimandEmbed(
  offender: GuildMember,
  issuer: { id: string; tag: string; toString(): string },
  typeName: string,
  reason: string,
  reprimandId: string,
  createdAt: Date,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('⚠️ ДИСЦИПЛИНАРНОЕ ВЗЫСКАНИЕ')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `**Нарушитель:** ${offender.toString()} (${offender.user.tag})\n` +
      `**Тип взыскания:** ${typeName}\n` +
      `**Причина:**\n> ${reason}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `**Выдал:** <@${issuer.id}>\n` +
      `**Дата:** <t:${Math.floor(createdAt.getTime() / 1000)}:F>\n` +
      `**ID:** \`${reprimandId.slice(-6)}\`\n` +
      `**Статус:** 🔴 Активен`,
    )
    .setColor(0xed4245)
    .setThumbnail(offender.displayAvatarURL({ size: 128 }));
}

function buildReprimandButtons(
  reprimandId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_appeal${RB_SEP}${reprimandId}`)
        .setLabel('❌ Не согласен с выговором')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${RB_PREFIX}${RB_SEP}rep_annul${RB_SEP}${reprimandId}`)
        .setLabel('✅ Аннулировать выговор')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildAppealInfoEmbed(
  offender: GuildMember | null,
  issuer: GuildMember | null,
  typeName: string,
  reason: string,
  reprimandId: string,
  createdAt: Date,
): BublikEmbed {
  return new BublikEmbed()
    .setTitle('📋 АПЕЛЛЯЦИЯ — Рассмотрение выговора')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `**Нарушитель:** ${offender?.toString() ?? '*неизвестен*'}\n` +
      `**Тип взыскания:** ${typeName}\n` +
      `**Причина:**\n> ${reason}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `**Выдал:** ${issuer?.toString() ?? '*неизвестен*'}\n` +
      `**Дата выговора:** <t:${Math.floor(createdAt.getTime() / 1000)}:F>\n` +
      `**ID выговора:** \`${reprimandId.slice(-6)}\`\n\n` +
      `Обсудите ситуацию в этих каналах.\n` +
      `Для аннуляции используйте кнопку в канале выговоров.`,
    )
    .setColor(0xfee75c);
}

/**
 * Обновить оригинальное сообщение выговора (статус)
 */
async function updateReprimandMessage(
  guild: any,
  reprimand: any,
  newStatus: string,
  config: any,
  annulledByTag?: string,
): Promise<void> {
  if (!reprimand.messageId || !reprimand.channelId) return;

  try {
    const channel = await guild.channels.fetch(reprimand.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const msg = await channel.messages.fetch(reprimand.messageId).catch(() => null);
    if (!msg) return;

    const offender = await guild.members.fetch(reprimand.offenderId).catch(() => null);
    const typeRole = guild.roles.cache.get(reprimand.typeRoleId);
    const typeName = typeRole?.name ?? 'Неизвестный тип';

    let statusLine: string;
    let color: number;

    if (newStatus === 'appealing') {
      statusLine = '🟡 Апелляция';
      color = 0xfee75c;
    } else if (newStatus === 'annulled') {
      statusLine = `🟢 Аннулирован${annulledByTag ? ` (${annulledByTag})` : ''}`;
      color = 0x57f287;
    } else {
      statusLine = '🔴 Активен';
      color = 0xed4245;
    }

    const embed = new BublikEmbed()
      .setTitle('⚠️ ДИСЦИПЛИНАРНОЕ ВЗЫСКАНИЕ')
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Нарушитель:** ${offender?.toString() ?? `<@${reprimand.offenderId}>`} (${offender?.user.tag ?? 'N/A'})\n` +
        `**Тип взыскания:** ${typeName}\n` +
        `**Причина:**\n> ${reprimand.reason}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Выдал:** <@${reprimand.issuerId}>\n` +
        `**Дата:** <t:${Math.floor(reprimand.createdAt.getTime() / 1000)}:F>\n` +
        `**ID:** \`${reprimand.id.slice(-6)}\`\n` +
        `**Статус:** ${statusLine}`,
      )
      .setColor(color);

    if (offender) embed.setThumbnail(offender.displayAvatarURL({ size: 128 }));

    // Если аннулирован — убрать кнопки
    const components = newStatus === 'annulled' ? [] : buildReprimandButtons(reprimand.id);

    await msg.edit({ embeds: [embed], components });
  } catch (err) {
    log.warn(`Не удалось обновить сообщение выговора ${reprimand.id}`, { error: String(err) });
  }
}
