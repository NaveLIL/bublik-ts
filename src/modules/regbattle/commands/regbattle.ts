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
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { withMemberRoleLock } from '../../../core/MemberRoleLock';
import {
  evaluateRolePolicy,
  fetchRolePolicySubject,
  loadInteractionRolePolicyContext,
  rolePolicyFailureMessage,
  hasDangerousAssignablePermissions,
} from '../../../core/RolePolicy';

import {
  getConfig,
  upsertConfig,
  getGuildSquads,
  deleteSquad,
} from '../database';
import { getSquadMemberCount } from '../utils';
import { recalculatePinger } from '../pinger';
import {
  deleteTrackedChannel,
  finishPbSession,
  refreshStatusPanel,
  teardownSquadIntegration,
} from '../lifecycle';

const log = logger.child('RegBattle:Command');

async function ensureRoleConfigurationAllowed(
  interaction: ChatInputCommandInteraction,
  roleIds: readonly string[],
  rejectDangerous = false,
): Promise<boolean> {
  const context = await loadInteractionRolePolicyContext(interaction);
  if (!context || !interaction.guild) {
    await interaction.reply({
      embeds: [errorEmbed(rolePolicyFailureMessage('wrong_guild'))],
      ephemeral: true,
    });
    return false;
  }

  for (const roleId of new Set(roleIds)) {
    const role = await fetchRolePolicySubject(interaction.guild, roleId);
    const decision = evaluateRolePolicy(context, role);
    if (!decision.ok) {
      await interaction.reply({
        embeds: [errorEmbed(rolePolicyFailureMessage(decision.reason))],
        ephemeral: true,
      });
      return false;
    }
    if (rejectDangerous && role && hasDangerousAssignablePermissions(role.permissions)) {
      await interaction.reply({
        embeds: [errorEmbed('Автоматически выдаваемая роль не может содержать административные права.')],
        ephemeral: true,
      });
      return false;
    }
  }
  return true;
}

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
        )
        .addChannelOption((opt) =>
          opt
            .setName('reprimand_channel')
            .setDescription('Канал для выговоров')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('reprimand_duration')
            .setDescription('Срок выговора в днях (0 = бессрочно)')
            .setMinValue(0)
            .setMaxValue(365)
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
              { name: '⚠️ Тип выговора', value: 'reprimand_type' },
              { name: '🛡️ Право аннуляции выговоров', value: 'reprimand_annul' },
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
              { name: '⚠️ Тип выговора', value: 'reprimand_type' },
              { name: '🛡️ Право аннуляции выговоров', value: 'reprimand_annul' },
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
    const locale = await getGuildLocale(interaction.guildId);

    // Все субкоманды требуют ManageGuild; изменение role-bearing конфигурации
    // дополнительно требует ManageRoles.
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('regbattle.error_admin_only', locale))],
        ephemeral: true,
      });
      return;
    }
    const roleConfigSubs = new Set(['setup', 'addrole', 'removerole']);
    if (roleConfigSubs.has(sub) && !perms.has(PermissionsBitField.Flags.ManageRoles)) {
      await interaction.reply({
        embeds: [errorEmbed('Для этой операции требуется право «Управлять ролями».')],
        ephemeral: true,
      });
      return;
    }

    switch (sub) {
      case 'setup':      await handleSetup(interaction, client, locale); break;
      case 'addrole':    await handleAddRole(interaction, locale); break;
      case 'removerole': await handleRemoveRole(interaction, locale); break;
      case 'config':     await handleConfig(interaction, locale); break;
      case 'status':     await handleStatus(interaction, locale); break;
      case 'close':      await handleClose(interaction, client, locale); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  /regbattle setup
// ═══════════════════════════════════════════════

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
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
  const reprimandChannel = interaction.options.getChannel('reprimand_channel');
  const reprimandDuration = interaction.options.getInteger('reprimand_duration');

  const suppliedRoles = [pingRole, inSquadRole, playedRole].filter(
    (role): role is NonNullable<typeof role> => Boolean(role),
  );
  if (suppliedRoles.length > 0
    && !(await ensureRoleConfigurationAllowed(interaction, suppliedRoles.map((role) => role.id), true))) {
    return;
  }

  // Первичная настройка — обязательные параметры
  if (!existing && (!master || !category || !announce || !pingRole || !inSquadRole)) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('regbattle.error_setup_required_first', locale))],
      ephemeral: true,
    });
    return;
  }

  const finalCoreRoleIds = [
    pingRole?.id ?? existing?.pingRoleId,
    inSquadRole?.id ?? existing?.inSquadRoleId,
    playedRole?.id ?? existing?.playedTodayRoleId,
  ].filter((roleId): roleId is string => Boolean(roleId));
  if (new Set(finalCoreRoleIds).size !== finalCoreRoleIds.length) {
    await interaction.reply({
      embeds: [errorEmbed('Роли «пинг», «в отряде» и «играл сегодня» должны быть разными.')],
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
  if (reprimandChannel) data.reprimandChannelId = reprimandChannel.id;
  if (reprimandDuration !== null) data.reprimandDurationDays = reprimandDuration;

  const config = await upsertConfig(guildId, data);
  const isNew = !existing;
  const changed = (key: string) => data[key] !== undefined ? ' ✏️' : '';

  const action = isNew
    ? i18n.t('regbattle.setup_action_new', locale)
    : i18n.t('regbattle.setup_action_update', locale);
  const nv = i18n.t('regbattle.setup_no_value', locale);
  const durText = config.reprimandDurationDays
    ? i18n.t('regbattle.setup_duration_days', locale, { n: config.reprimandDurationDays })
    : i18n.t('regbattle.setup_duration_indefinite', locale);

  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('regbattle.setup_success_title', locale, { action }) + `\n\n` +
      `> ${i18n.t('regbattle.setup_field_master', locale)} ${config.masterChannelId ? `<#${config.masterChannelId}>` : nv}${changed('masterChannelId')}\n` +
      `> ${i18n.t('regbattle.setup_field_category', locale)} ${config.categoryId ? `<#${config.categoryId}>` : nv}${changed('categoryId')}\n` +
      `> ${i18n.t('regbattle.setup_field_announce', locale)} ${config.announceChannelId ? `<#${config.announceChannelId}>` : nv}${changed('announceChannelId')}\n` +
      `> ${i18n.t('regbattle.setup_field_reserve', locale)} ${config.reserveChannelId ? `<#${config.reserveChannelId}>` : nv}${changed('reserveChannelId')}\n` +
      `> ${i18n.t('regbattle.setup_field_ping_role', locale)} ${config.pingRoleId ? `<@&${config.pingRoleId}>` : nv}${changed('pingRoleId')}\n` +
      `> ${i18n.t('regbattle.setup_field_insquad_role', locale)} ${config.inSquadRoleId ? `<@&${config.inSquadRoleId}>` : nv}${changed('inSquadRoleId')}\n` +
      `> ${i18n.t('regbattle.setup_field_squad_size', locale)} ${config.squadSize}${changed('squadSize')}\n` +
      `> ${i18n.t('regbattle.setup_field_air_size', locale)} ${config.airSize}${changed('airSize')}\n` +
      `> ${i18n.t('regbattle.setup_field_played_role', locale)} ${config.playedTodayRoleId ? `<@&${config.playedTodayRoleId}>` : nv}${changed('playedTodayRoleId')}\n` +
      `> ${i18n.t('regbattle.setup_field_played_min', locale)} ${config.playedMinMinutes ?? 15}${changed('playedMinMinutes')}\n` +
      `> ${i18n.t('regbattle.setup_field_played_reset', locale)} ${config.playedResetHour ?? 23}:00${changed('playedResetHour')}\n` +
      `> ${i18n.t('regbattle.setup_field_reprimand', locale)} ${config.reprimandChannelId ? `<#${config.reprimandChannelId}>` : nv}${changed('reprimandChannelId')}\n` +
      `> ${i18n.t('regbattle.setup_field_reprimand_duration', locale)} ${durText}${changed('reprimandDurationDays')}\n` +
      (isNew ? `\n${i18n.t('regbattle.setup_next_steps', locale)}` : ''),
    )],
    ephemeral: true,
  });

  if (interaction.guild) {
    await refreshStatusPanel(interaction.guild, client, true);
  }

  log.info(`RegBattle setup: ${interaction.guild?.name}`);
}

// ═══════════════════════════════════════════════
//  /regbattle addrole
// ═══════════════════════════════════════════════

async function handleAddRole(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const botAssignsRole = type === 'reprimand_type' || type === 'reprimand_annul';
  if (!(await ensureRoleConfigurationAllowed(interaction, [role.id], botAssignsRole))) return;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('regbattle.error_run_setup_first', locale))], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    commander: 'commanderRoleIds',
    mute: 'muteRoleIds',
    reprimand_type: 'reprimandTypeRoleIds',
    reprimand_annul: 'reprimandAnnulRoleIds',
  };
  const field = fieldMap[type] as 'commanderRoleIds' | 'muteRoleIds' | 'reprimandTypeRoleIds' | 'reprimandAnnulRoleIds';
  const current: string[] = config[field];

  if (current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('regbattle.addrole_already', locale, { role: `<@&${role.id}>` }))], ephemeral: true });
    return;
  }

  const updated = [...current, role.id];
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    commander: i18n.t('regbattle.type_label_commander', locale),
    mute: i18n.t('regbattle.type_label_mute', locale),
    reprimand_type: i18n.t('regbattle.type_label_reprimand_type', locale),
    reprimand_annul: i18n.t('regbattle.type_label_reprimand_annul', locale),
  };

  const list = updated.map((id) => `<@&${id}>`).join(', ');
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('regbattle.addrole_success', locale, { role: `<@&${role.id}>`, type: typeLabels[type], list }),
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle removerole
// ═══════════════════════════════════════════════

async function handleRemoveRole(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('regbattle.error_run_setup_first', locale))], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    commander: 'commanderRoleIds',
    mute: 'muteRoleIds',
    reprimand_type: 'reprimandTypeRoleIds',
    reprimand_annul: 'reprimandAnnulRoleIds',
  };
  const field = fieldMap[type] as 'commanderRoleIds' | 'muteRoleIds' | 'reprimandTypeRoleIds' | 'reprimandAnnulRoleIds';
  const current: string[] = config[field];

  if (!current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('regbattle.removerole_not_in_list', locale, { role: `<@&${role.id}>` }))], ephemeral: true });
    return;
  }

  const updated = current.filter((id) => id !== role.id);
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    commander: i18n.t('regbattle.type_label_commander', locale),
    mute: i18n.t('regbattle.type_label_mute', locale),
    reprimand_type: i18n.t('regbattle.type_label_reprimand_type', locale),
    reprimand_annul: i18n.t('regbattle.type_label_reprimand_annul', locale),
  };

  const list = updated.length > 0 ? updated.map((id) => `<@&${id}>`).join(', ') : i18n.t('regbattle.role_list_empty', locale);
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('regbattle.removerole_success', locale, { role: `<@&${role.id}>`, type: typeLabels[type], list }),
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle config
// ═══════════════════════════════════════════════

async function handleConfig(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const config = await getConfig(interaction.guildId!);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('regbattle.error_pb_not_configured', locale))],
      ephemeral: true,
    });
    return;
  }

  const nv = i18n.t('regbattle.setup_no_value', locale);
  const fmt = (ids: string[], prefix: string) =>
    ids.length > 0 ? ids.map((id) => `<${prefix}${id}>`).join(', ') : i18n.t('regbattle.config_roles_not_set', locale);
  const durText = config.reprimandDurationDays
    ? i18n.t('regbattle.setup_duration_days', locale, { n: config.reprimandDurationDays })
    : i18n.t('regbattle.setup_duration_indefinite', locale);

  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('regbattle.config_title', locale) + `\n\n` +
      `> ${i18n.t('regbattle.setup_field_master', locale)} ${config.masterChannelId ? `<#${config.masterChannelId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_category', locale)} ${config.categoryId ? `<#${config.categoryId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_announce', locale)} ${config.announceChannelId ? `<#${config.announceChannelId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_reserve', locale)} ${config.reserveChannelId ? `<#${config.reserveChannelId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_ping_role', locale)} ${config.pingRoleId ? `<@&${config.pingRoleId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_insquad_role', locale)} ${config.inSquadRoleId ? `<@&${config.inSquadRoleId}>` : nv}\n` +
      `> ${i18n.t('regbattle.config_field_commanders', locale)} ${fmt(config.commanderRoleIds, '@&')}\n` +
      `> ${i18n.t('regbattle.config_field_unmuteable', locale)} ${fmt(config.muteRoleIds, '@&')}\n` +
      `> ${i18n.t('regbattle.setup_field_squad_size', locale)} ${config.squadSize}\n` +
      `> ${i18n.t('regbattle.setup_field_air_size', locale)} ${config.airSize}\n` +
      `> ${i18n.t('regbattle.setup_field_played_role', locale)} ${config.playedTodayRoleId ? `<@&${config.playedTodayRoleId}>` : nv}\n` +
      `> ${i18n.t('regbattle.setup_field_played_min', locale)} ${config.playedMinMinutes ?? 15}\n` +
      `> ${i18n.t('regbattle.setup_field_played_reset', locale)} ${config.playedResetHour ?? 23}:00\n` +
      `> ${i18n.t('regbattle.config_field_escalate', locale)} ${i18n.t('regbattle.config_field_escalate_value', locale, { n: config.pingEscalateAfter })}\n` +
      `> ${i18n.t('regbattle.config_field_reprimand_channel', locale)} ${config.reprimandChannelId ? `<#${config.reprimandChannelId}>` : nv}\n` +
      `> ${i18n.t('regbattle.config_field_reprimand_types', locale)} ${fmt(config.reprimandTypeRoleIds, '@&')}\n` +
      `> ${i18n.t('regbattle.config_field_reprimand_annul', locale)} ${fmt(config.reprimandAnnulRoleIds, '@&')}\n` +
      `> ${i18n.t('regbattle.setup_field_reprimand_duration', locale)} ${durText}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle status
// ═══════════════════════════════════════════════

async function handleStatus(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('regbattle.error_pb_not_configured_short', locale))],
      ephemeral: true,
    });
    return;
  }

  const squads = await getGuildSquads(guildId);
  if (squads.length === 0) {
    await interaction.reply({
      embeds: [successEmbed(i18n.t('regbattle.status_no_squads', locale))],
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild!;
  const lines = squads.map((s: any) => {
    const count = getSquadMemberCount(guild, s.voiceChannelId, s.airChannelId);
    const status = count >= config.squadSize ? '✅' : '⚠️';
    const owner = guild.members.cache.get(s.ownerId)?.displayName ?? i18n.t('regbattle.status_owner_unknown', locale);
    const air = s.airChannelId ? ` | ✈️ <#${s.airChannelId}>` : '';
    return i18n.t('regbattle.status_line', locale, {
      status,
      n: s.number,
      count,
      size: config.squadSize,
      owner,
      channel: `<#${s.voiceChannelId}>${air}`,
    });
  });

  await interaction.reply({
    embeds: [successEmbed(i18n.t('regbattle.status_title', locale) + `\n\n${lines.join('\n')}`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /regbattle close
// ═══════════════════════════════════════════════

async function handleClose(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const guildId = interaction.guildId!;
  const squads = await getGuildSquads(guildId);

  if (squads.length === 0) {
    await interaction.deferReply({ ephemeral: true });
    if (interaction.guild) await refreshStatusPanel(interaction.guild, client, true);
    await interaction.editReply({
      embeds: [successEmbed(i18n.t('regbattle.close_no_squads', locale))],
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const config = await getConfig(guildId);
  let closed = 0;

  for (const squad of squads) {
    try {
      // Finish only proven persistent sessions. Legacy outsiders never receive
      // ping/played/team roles merely because /close found them in the voice.
      if (config) {
        const mainVc = guild.channels.cache.get(squad.voiceChannelId) as VoiceChannel | undefined;
        const members = new Map<string, import('discord.js').GuildMember>();
        if (mainVc) {
          for (const [id, member] of mainVc.members) members.set(id, member);
        }
        const airVc = squad.airChannelId
          ? (guild.channels.cache.get(squad.airChannelId) as VoiceChannel | undefined)
          : null;
        if (airVc) {
          for (const [id, member] of airVc.members) members.set(id, member);
        }
        for (const member of members.values()) {
          if (member.user.bot) continue;
          const finished = await finishPbSession(member, config);
          if (!finished && config.inSquadRoleId && member.roles.cache.has(config.inSquadRoleId)) {
            await withMemberRoleLock(guild.id, member.id, async (lock) => {
              await lock.assertOwned();
              await member.roles.remove(config.inSquadRoleId!, 'RegBattle close: orphan role');
              await lock.assertOwned();
            }).catch(() => null);
          }
        }
      }

      const airDeleted = !squad.airChannelId || await deleteTrackedChannel(
        guild,
        squad.airChannelId,
        'ПБ: расформирование по команде',
      );
      const mainDeleted = await deleteTrackedChannel(
        guild,
        squad.voiceChannelId,
        'ПБ: расформирование по команде',
      );
      if (!airDeleted || !mainDeleted) continue;
      if (!(await teardownSquadIntegration(squad, client))) continue;
      await deleteSquad(squad.id);
      closed++;
    } catch (err) {
      log.error(`Ошибка при расформировании отряда ${squad.number}`, { error: String(err) });
    }
  }

  await refreshStatusPanel(guild, client, true);
  recalculatePinger(guildId);

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('regbattle.close_success', locale, { closed, total: squads.length }))],
  });

  log.info(`Расформировано ${closed} отрядов ПБ (admin: ${interaction.user.tag})`);
}

export default regbattleCommand;
