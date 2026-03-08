// ═══════════════════════════════════════════════
//  /regbattle — Админская команда настройки ПБ
//
//  Субкоманды:
//  • setup     — настройка системы (каналы, роли)
//  • addrole   — добавить роль (commander/mute)
//  • removerole— убрать роль
//  • config    — показать текущую конфигурацию
//  • status    — статус активных отрядов
//  • close     — расформировать все отряды
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  VoiceChannel,
  TextChannel,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';

import {
  getConfig,
  upsertConfig,
  getGuildSquads,
  deleteSquad,
} from '../database';
import { getSquadMemberCount } from '../utils';
import { recalculatePinger } from '../pinger';

const log = logger.child('RegBattle:Command');

const regbattleCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('regbattle')
    .setDescription('Управление системой полковых боёв (ПБ)')

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить систему ПБ')
        .addChannelOption((opt) =>
          opt
            .setName('master')
            .setDescription('Войс-канал генератор (из него создаются отряды)')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('category')
            .setDescription('Категория для временных каналов ПБ')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('announce')
            .setDescription('Текстовый канал для пингов и оповещений')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('reserve')
            .setDescription('Войс-канал запасных')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('ping_role')
            .setDescription('Роль для пинга доступных бойцов')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('insquad_role')
            .setDescription('Роль «В отряде» (выдаётся при входе в ПБ-войс)')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('squad_size')
            .setDescription('Целевой размер отряда (по умолчанию 8)')
            .setMinValue(2)
            .setMaxValue(99)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('air_size')
            .setDescription('Макс. людей в авиа-канале (по умолчанию 4)')
            .setMinValue(1)
            .setMaxValue(20)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('played_role')
            .setDescription('Роль «Играл сегодня» (не пингуется до сброса)')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('played_min')
            .setDescription('Мин. минут в ПБ-войсе для роли (по умолч. 15)')
            .setMinValue(1)
            .setMaxValue(240)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('played_reset')
            .setDescription('Час сброса роли по МСК (0-23, по умолч. 23)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(false),
        ),
    )

    // ── addrole ───────────────────
    .addSubcommand((sub) =>
      sub
        .setName('addrole')
        .setDescription('Добавить роль в конфигурацию ПБ')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🎖️ Полевой командир', value: 'commander' },
              { name: '🔇 Немьютимая (РАСПОРЯЖЕНИЯ)', value: 'mute' },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Роль').setRequired(true),
        ),
    )

    // ── removerole ────────────────
    .addSubcommand((sub) =>
      sub
        .setName('removerole')
        .setDescription('Убрать роль из конфигурации ПБ')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🎖️ Полевой командир', value: 'commander' },
              { name: '🔇 Немьютимая (РАСПОРЯЖЕНИЯ)', value: 'mute' },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Роль').setRequired(true),
        ),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Показать текущую конфигурацию ПБ'),
    )

    // ── status ────────────────────
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Статус активных отрядов'),
    )

    // ── close ─────────────────────
    .addSubcommand((sub) =>
      sub.setName('close').setDescription('Расформировать все активные отряды'),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.regbattle.description',
  cooldown: 3,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();

    // Все субкоманды требуют ManageGuild
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed('Эта команда доступна только администраторам.')],
        ephemeral: true,
      });
      return;
    }

    switch (sub) {
      case 'setup':      await handleSetup(interaction, client); break;
      case 'addrole':    await handleAddRole(interaction); break;
      case 'removerole': await handleRemoveRole(interaction); break;
      case 'config':     await handleConfig(interaction); break;
      case 'status':     await handleStatus(interaction); break;
      case 'close':      await handleClose(interaction, client); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  /regbattle setup
// ═══════════════════════════════════════════════

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId!;
  const existing = await getConfig(guildId);

  const master = interaction.options.getChannel('master');
  const category = interaction.options.getChannel('category');
  const announce = interaction.options.getChannel('announce');
  const reserve = interaction.options.getChannel('reserve');
  const pingRole = interaction.options.getRole('ping_role');
  const inSquadRole = interaction.options.getRole('insquad_role');
  const playedRole = interaction.options.getRole('played_role');
  const squadSize = interaction.options.getInteger('squad_size');
  const airSize = interaction.options.getInteger('air_size');
  const playedMin = interaction.options.getInteger('played_min');
  const playedReset = interaction.options.getInteger('played_reset');

  // Первичная настройка — обязательные параметры
  if (!existing && (!master || !category || !announce || !pingRole || !inSquadRole)) {
    await interaction.reply({
      embeds: [errorEmbed(
        'Первичная настройка требует **все основные** параметры:\n' +
        '`/regbattle setup master:#войс category:#категория announce:#текст ping_role:@роль insquad_role:@роль`',
      )],
      ephemeral: true,
    });
    return;
  }

  const data: Record<string, any> = {};
  if (master) data.masterChannelId = master.id;
  if (category) data.categoryId = category.id;
  if (announce) data.announceChannelId = announce.id;
  if (reserve) data.reserveChannelId = reserve.id;
  if (pingRole) data.pingRoleId = pingRole.id;
  if (inSquadRole) data.inSquadRoleId = inSquadRole.id;
  if (playedRole) data.playedTodayRoleId = playedRole.id;
  if (squadSize !== null) data.squadSize = squadSize;
  if (airSize !== null) data.airSize = airSize;
  if (playedMin !== null) data.playedMinMinutes = playedMin;
  if (playedReset !== null) data.playedResetHour = playedReset;

  const config = await upsertConfig(guildId, data);
  const isNew = !existing;
  const changed = (key: string) => data[key] !== undefined ? ' ✏️' : '';

  await interaction.reply({
    embeds: [successEmbed(
      `🏰 **Система ПБ ${isNew ? 'настроена' : 'обновлена'}!**\n\n` +
      `> 🔊 **Генератор:** ${config.masterChannelId ? `<#${config.masterChannelId}>` : '*—*'}${changed('masterChannelId')}\n` +
      `> 📁 **Категория:** ${config.categoryId ? `<#${config.categoryId}>` : '*—*'}${changed('categoryId')}\n` +
      `> 📢 **Оповещения:** ${config.announceChannelId ? `<#${config.announceChannelId}>` : '*—*'}${changed('announceChannelId')}\n` +
      `> 🪖 **Запасные:** ${config.reserveChannelId ? `<#${config.reserveChannelId}>` : '*—*'}${changed('reserveChannelId')}\n` +
      `> 🔔 **Пинг-роль:** ${config.pingRoleId ? `<@&${config.pingRoleId}>` : '*—*'}${changed('pingRoleId')}\n` +
      `> 🎖️ **В отряде:** ${config.inSquadRoleId ? `<@&${config.inSquadRoleId}>` : '*—*'}${changed('inSquadRoleId')}\n` +
      `> 👥 **Размер отряда:** ${config.squadSize}${changed('squadSize')}\n` +
      `> ✈️ **Авиация (макс.):** ${config.airSize}${changed('airSize')}\n` +
      `> 🎮 **Играл сегодня:** ${config.playedTodayRoleId ? `<@&${config.playedTodayRoleId}>` : '*—*'}${changed('playedTodayRoleId')}\n` +
      `> ⏱️ **Мин. минут для роли:** ${config.playedMinMinutes ?? 15}${changed('playedMinMinutes')}\n` +
      `> 🔄 **Сброс роли (МСК):** ${config.playedResetHour ?? 23}:00${changed('playedResetHour')}\n` +
      (isNew ? `\nДалее:\n` +
        `• \`/regbattle addrole type:commander\` — роли полевых командиров\n` +
        `• \`/regbattle addrole type:mute\` — роли-исключения из мьюта\n` +
        `• Зайдите в генератор для создания отряда` : ''),
    )],
    ephemeral: true,
  });

  log.info(`RegBattle setup: ${interaction.guild?.name}`);
}

// ═══════════════════════════════════════════════
//  /regbattle addrole
// ═══════════════════════════════════════════════

async function handleAddRole(interaction: ChatInputCommandInteraction): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed('Сначала выполните `/regbattle setup`.')], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    commander: 'commanderRoleIds',
    mute: 'muteRoleIds',
  };
  const field = fieldMap[type] as 'commanderRoleIds' | 'muteRoleIds';
  const current: string[] = config[field];

  if (current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(`<@&${role.id}> уже в списке.`)], ephemeral: true });
    return;
  }

  const updated = [...current, role.id];
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    commander: '🎖️ Полевые командиры',
    mute: '🔇 Немьютимые',
  };

  const list = updated.map((id) => `<@&${id}>`).join(', ');
  await interaction.reply({
    embeds: [successEmbed(
      `<@&${role.id}> добавлена в **${typeLabels[type]}**.\n\n> **Список:** ${list}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle removerole
// ═══════════════════════════════════════════════

async function handleRemoveRole(interaction: ChatInputCommandInteraction): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed('Сначала выполните `/regbattle setup`.')], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    commander: 'commanderRoleIds',
    mute: 'muteRoleIds',
  };
  const field = fieldMap[type] as 'commanderRoleIds' | 'muteRoleIds';
  const current: string[] = config[field];

  if (!current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(`<@&${role.id}> не в списке.`)], ephemeral: true });
    return;
  }

  const updated = current.filter((id) => id !== role.id);
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    commander: '🎖️ Полевые командиры',
    mute: '🔇 Немьютимые',
  };

  const list = updated.length > 0 ? updated.map((id) => `<@&${id}>`).join(', ') : '*нет*';
  await interaction.reply({
    embeds: [successEmbed(
      `<@&${role.id}> убрана из **${typeLabels[type]}**.\n\n> **Список:** ${list}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle config
// ═══════════════════════════════════════════════

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const config = await getConfig(interaction.guildId!);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed('Система ПБ не настроена. Используйте `/regbattle setup`.')],
      ephemeral: true,
    });
    return;
  }

  const fmt = (ids: string[], prefix: string) =>
    ids.length > 0 ? ids.map((id) => `<${prefix}${id}>`).join(', ') : '*не настроены*';

  await interaction.reply({
    embeds: [successEmbed(
      `⚙️ **Конфигурация системы ПБ:**\n\n` +
      `> 🔊 **Генератор:** ${config.masterChannelId ? `<#${config.masterChannelId}>` : '*—*'}\n` +
      `> 📁 **Категория:** ${config.categoryId ? `<#${config.categoryId}>` : '*—*'}\n` +
      `> 📢 **Оповещения:** ${config.announceChannelId ? `<#${config.announceChannelId}>` : '*—*'}\n` +
      `> 🪖 **Запасные:** ${config.reserveChannelId ? `<#${config.reserveChannelId}>` : '*—*'}\n` +
      `> 🔔 **Пинг-роль:** ${config.pingRoleId ? `<@&${config.pingRoleId}>` : '*—*'}\n` +
      `> 🎖️ **В отряде:** ${config.inSquadRoleId ? `<@&${config.inSquadRoleId}>` : '*—*'}\n` +
      `> 🎖️ **Командиры:** ${fmt(config.commanderRoleIds, '@&')}\n` +
      `> 🔇 **Немьютимые:** ${fmt(config.muteRoleIds, '@&')}\n` +
      `> 👥 **Размер отряда:** ${config.squadSize}\n` +
      `> ✈️ **Авиация (макс.):** ${config.airSize}\n` +
      `> 🎮 **Играл сегодня:** ${config.playedTodayRoleId ? `<@&${config.playedTodayRoleId}>` : '*—*'}\n` +
      `> ⏱️ **Мин. минут для роли:** ${config.playedMinMinutes ?? 15}\n` +
      `> 🔄 **Сброс роли (МСК):** ${config.playedResetHour ?? 23}:00\n` +
      `> 📊 **Эскалация через:** ${config.pingEscalateAfter} пингов`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle status
// ═══════════════════════════════════════════════

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed('Система ПБ не настроена.')],
      ephemeral: true,
    });
    return;
  }

  const squads = await getGuildSquads(guildId);
  if (squads.length === 0) {
    await interaction.reply({
      embeds: [successEmbed('🏰 Нет активных отрядов.')],
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild!;
  const lines = squads.map((s: any) => {
    const count = getSquadMemberCount(guild, s.voiceChannelId, s.airChannelId);
    const status = count >= config.squadSize ? '✅' : '⚠️';
    const owner = guild.members.cache.get(s.ownerId)?.displayName ?? 'Неизвестный';
    const air = s.airChannelId ? ` | ✈️ <#${s.airChannelId}>` : '';
    return `${status} **ОТРЯД ${s.number}** — ${count}/${config.squadSize} | 🎖️ ${owner} | <#${s.voiceChannelId}>${air}`;
  });

  await interaction.reply({
    embeds: [successEmbed(`🏰 **Активные отряды:**\n\n${lines.join('\n')}`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle close
// ═══════════════════════════════════════════════

async function handleClose(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
): Promise<void> {
  const guildId = interaction.guildId!;
  const squads = await getGuildSquads(guildId);

  if (squads.length === 0) {
    await interaction.reply({
      embeds: [successEmbed('Нет активных отрядов для расформирования.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = await getConfig(guildId);
  let closed = 0;

  for (const squad of squads) {
    try {
      // Восстановить роли всем участникам
      if (config) {
        const restoreMember = async (member: GuildMember) => {
          if (member.user.bot) return;
          if (config.inSquadRoleId && member.roles.cache.has(config.inSquadRoleId)) {
            await member.roles.remove(config.inSquadRoleId).catch(() => null);
          }
          if (config.playedTodayRoleId && member.roles.cache.has(config.playedTodayRoleId)) {
            await member.roles.remove(config.playedTodayRoleId).catch(() => null);
          }
          if (config.pingRoleId && !member.roles.cache.has(config.pingRoleId)) {
            await member.roles.add(config.pingRoleId).catch(() => null);
          }
        };

        const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
        if (mainVc) {
          for (const [, member] of mainVc.members) {
            await restoreMember(member);
          }
        }
        const airVc = squad.airChannelId
          ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
          : null;
        if (airVc) {
          for (const [, member] of airVc.members) {
            await restoreMember(member);
          }
          await airVc.delete('ПБ: расформирование по команде').catch(() => null);
        }
        if (mainVc) {
          await mainVc.delete('ПБ: расформирование по команде').catch(() => null);
        }
      }

      await deleteSquad(squad.id);
      closed++;
    } catch (err) {
      log.error(`Ошибка при расформировании отряда ${squad.number}`, { error: String(err) });
    }
  }

  recalculatePinger(guildId);

  await interaction.editReply({
    embeds: [successEmbed(`🏰 Расформировано отрядов: **${closed}/${squads.length}**. Роли восстановлены.`)],
  });

  log.info(`Расформировано ${closed} отрядов ПБ (admin: ${interaction.user.tag})`);
}

export default regbattleCommand;
