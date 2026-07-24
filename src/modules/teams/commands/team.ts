// ═══════════════════════════════════════════════
//  /team — Управление командами ПБ
//
//  Субкоманды:
//  • create       — создать команду
//  • manage       — управление своей командой (лидер)
//  • info         — информация о команде
//  • leaderboard  — рейтинг команд
//  • setup        — настройка системы (админ)
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';

import * as db from '../database';
import { getCurrentSeason } from '../constants';
import {
  tmSuccess,
  tmError,
  buildTeamInfoEmbed,
  buildTeamManageButtons,
} from '../embeds';
import { handleCreateStart } from '../creation';
import { showLeaderboard } from '../statistics';

const log = logger.child('Teams:Command');

const teamCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('team')
    .setDescription('Управление командами полковых боёв')

    // ── create ─────────────────────
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Создать новую команду'),
    )

    // ── manage ─────────────────────
    .addSubcommand(sub =>
      sub
        .setName('manage')
        .setDescription('Управление вашей командой (для лидера)'),
    )

    // ── info ───────────────────────
    .addSubcommand(sub =>
      sub
        .setName('info')
        .setDescription('Информация о вашей команде')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('Участник, чью команду показать')
            .setRequired(false),
        ),
    )

    // ── leaderboard ────────────────
    .addSubcommand(sub =>
      sub
        .setName('leaderboard')
        .setDescription('Рейтинг команд сезона'),
    )

    // ── setup ──────────────────────
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription('Настройка системы команд (администратор)')
        .addChannelOption(opt =>
          opt
            .setName('application_channel')
            .setDescription('Канал для заявок на создание команды')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption(opt =>
          opt
            .setName('report_channel')
            .setDescription('Канал для отчётов после ПБ')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption(opt =>
          opt
            .setName('poll_channel')
            .setDescription('Канал для опросов/сборов')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption(opt =>
          opt
            .setName('leaderboard_channel')
            .setDescription('Канал для лидерборда')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addRoleOption(opt =>
          opt
            .setName('base_role')
            .setDescription('Базовая роль для участия (например: Полковой боец)')
            .setRequired(false),
        )
        .addStringOption(opt =>
          opt
            .setName('approver_roles')
            .setDescription('ID ролей одобрителей через запятую')
            .setRequired(false),
        )
        .addIntegerOption(opt =>
          opt
            .setName('min_size')
            .setDescription('Минимальный размер команды (по умолчанию 10)')
            .setMinValue(5)
            // Discord allows selecting at most 25 invitees; leader is #26.
            .setMaxValue(26)
            .setRequired(false),
        ),
    ) as SlashCommandBuilder,

  scope: CommandScope.Guild,
  category: 'teams',
  descriptionKey: 'commands.team.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const locale = await getGuildLocale(interaction.guildId);

    switch (sub) {
      case 'create':      await handleCreateStart(interaction, client); break;
      case 'manage':      await handleManage(interaction, client, locale); break;
      case 'info':        await handleInfo(interaction, client, locale); break;
      case 'leaderboard': await handleLeaderboardCmd(interaction, client, locale); break;
      case 'setup':       await handleSetup(interaction, client, locale); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  Субкоманды
// ═══════════════════════════════════════════════

async function handleManage(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const team = await db.getMemberTeam(interaction.user.id, interaction.guildId!);
  if (!team) {
    await interaction.reply({
      embeds: [tmError(i18n.t('teams.error_not_in_team', locale))],
      ephemeral: true,
    });
    return;
  }

  if (team.leaderId !== interaction.user.id) {
    await interaction.reply({
      embeds: [tmError(i18n.t('teams.error_not_leader', locale))],
      ephemeral: true,
    });
    return;
  }

  const members = await db.getTeamMembers(team.id);
  const { season, year } = getCurrentSeason();
  const seasonStats = await db.getSeason(team.id, season, year);

  const embed = buildTeamInfoEmbed(
    team.name,
    team.leaderId,
    team.roleId,
    team.status,
    members.length,
    members,
    seasonStats,
  );
  const buttons = buildTeamManageButtons(team.id);

  await interaction.reply({
    embeds: [embed],
    components: buttons,
    ephemeral: true,
  });
}

async function handleInfo(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const team = await db.getMemberTeam(targetUser.id, interaction.guildId!);

  if (!team) {
    await interaction.reply({
      embeds: [tmError(i18n.t('teams.error_user_no_team', locale, { user: targetUser.tag }))],
      ephemeral: true,
    });
    return;
  }

  const members = await db.getTeamMembers(team.id);
  const { season, year } = getCurrentSeason();
  const seasonStats = await db.getSeason(team.id, season, year);

  const embed = buildTeamInfoEmbed(
    team.name,
    team.leaderId,
    team.roleId,
    team.status,
    members.length,
    members,
    seasonStats,
  );

  await interaction.reply({ embeds: [embed] });
}

async function handleLeaderboardCmd(
  interaction: ChatInputCommandInteraction,
  _client: BublikClient,
  _locale: string,
): Promise<void> {
  await interaction.deferReply();

  const guildId = interaction.guildId!;
  const { embed, row } = await showLeaderboard(guildId);

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  _client: BublikClient,
  locale: string,
): Promise<void> {
  const perms = interaction.memberPermissions;
  if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('teams.error_admin_only', locale))],
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId!;
  const opts = interaction.options;
  const data: Record<string, any> = {};

  const appChannel = opts.getChannel('application_channel');
  const reportChannel = opts.getChannel('report_channel');
  const pollChannel = opts.getChannel('poll_channel');
  const lbChannel = opts.getChannel('leaderboard_channel');
  const baseRole = opts.getRole('base_role');
  const approverRolesStr = opts.getString('approver_roles');
  const minSize = opts.getInteger('min_size');

  if (appChannel) data.applicationChannelId = appChannel.id;
  if (reportChannel) data.reportChannelId = reportChannel.id;
  if (pollChannel) data.pollChannelId = pollChannel.id;
  if (lbChannel) data.leaderboardChannelId = lbChannel.id;
  if (baseRole) data.baseRoleId = baseRole.id;
  if (minSize !== null) data.minSize = minSize;
  if (approverRolesStr !== null) {
    data.approverRoleIds = approverRolesStr
      .split(',')
      .map(id => id.trim())
      .filter(id => /^\d{17,20}$/.test(id));
  }

  if (Object.keys(data).length === 0) {
    // Показать текущую конфигурацию
    const config = await db.getConfig(guildId);
    if (!config) {
      await interaction.reply({
        embeds: [tmError(i18n.t('teams.setup_no_config', locale))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        tmSuccess(
          `**Конфигурация Teams**\n\n` +
          `📋 Заявки: ${config.applicationChannelId ? `<#${config.applicationChannelId}>` : '—'}\n` +
          `📝 Отчёты: ${config.reportChannelId ? `<#${config.reportChannelId}>` : '—'}\n` +
          `📊 Опросы: ${config.pollChannelId ? `<#${config.pollChannelId}>` : '—'}\n` +
          `🏆 Лидерборд: ${config.leaderboardChannelId ? `<#${config.leaderboardChannelId}>` : '—'}\n` +
          `🎯 Базовая роль: ${config.baseRoleId ? `<@&${config.baseRoleId}>` : '—'}\n` +
          `✅ Одобрители: ${config.approverRoleIds?.length ? config.approverRoleIds.map((r: string) => `<@&${r}>`).join(', ') : '—'}\n` +
          `👥 Мин. размер: **${config.minSize ?? 10}**`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await db.upsertConfig(guildId, data);
  await interaction.reply({
    embeds: [tmSuccess(i18n.t('teams.setup_updated', locale))],
    ephemeral: true,
  });
  log.info(`Конфигурация обновлена: ${guildId}`);
}

export default teamCommand;
