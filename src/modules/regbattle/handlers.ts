// ═══════════════════════════════════════════════
//  RegBattle — Обработчики интеракций
//
//  Кнопки панели управления отрядом:
//  1. РАСПОРЯЖЕНИЯ — мьют на 30 сек
//  2. КИК — выбор + отключение из войса
//  3. ПИНГ В ЛС — рассылка DM + отчёт
//  4. АВИАЦИЯ — создание авиа-канала
//  5. ПЕРЕДАТЬ ПРАВА — передача командования
// ═══════════════════════════════════════════════

import {
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  GuildMember,
  VoiceChannel,
  ChannelType,
  PermissionsBitField,
} from 'discord.js';
import type { BublikClient } from '../../bot';
import { logger } from '../../core/Logger';
import { errorReporter } from '../../core/ErrorReporter';
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
} from './database';

import {
  airName,
  getSquadMembers,
  getSquadMemberCount,
  applySquadRoles,
} from './utils';

import {
  buildKickSelect,
  buildTransferSelect,
  buildOrdersActiveEmbed,
  buildOrdersEndedEmbed,
  buildDmPingEmbed,
  buildDmPingReport,
  buildControlPanelEmbed,
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
        case 'dmping':
          await handleDmPing(interaction, squadId, client);
          break;
        case 'aviation':
          await handleAviation(interaction, squadId, client);
          break;
        case 'transfer':
          await handleTransfer(interaction, squadId, client);
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

    // Мьютить всех с muteRoleIds, или всех если muteRoleIds пуст
    if (config.muteRoleIds.length === 0) {
      toMute.push(member);
    } else {
      const hasRole = config.muteRoleIds.some((id: string) => member.roles.cache.has(id));
      if (hasRole) toMute.push(member);
    }
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

  const targets = role.members.filter((m) => !m.user.bot);
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
