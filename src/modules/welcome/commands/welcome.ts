// ═══════════════════════════════════════════════
//  /welcome — Команда настройки модуля приветствий
//
//  Субкоманды:
//  • setup     — настроить / изменить роли и каналы
//  • config    — показать текущую конфигурацию
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  Role,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { BublikEmbed, successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { getGuildConfig, updateGuildConfig } from '../../../core/GuildConfig';
import { getGuildLocale } from '../../../core/GuildConfig';
import { i18n } from '../../../core/I18n';
import {
  evaluateRolePolicy,
  fetchRolePolicySubject,
  loadInteractionRolePolicyContext,
  rolePolicyFailureMessage,
} from '../../../core/RolePolicy';
import {
  areWelcomeRoleIdsDistinct,
  hasDangerousWelcomeRolePermissions,
} from '../policy';

const log = logger.child('Welcome:Command');

const welcomeCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Настройка модуля приветствий')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить / изменить роли и каналы приветствия')
        .addRoleOption((opt) =>
          opt
            .setName('auto_role')
            .setDescription('Роль, выдаваемая каждому новому участнику при входе')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('member_role')
            .setDescription('Роль участника (при получении — авто-роль снимается)')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('recruit_role')
            .setDescription('Роль кандидата (выдаётся после прочтения правил)')
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('welcome_channel')
            .setDescription('Канал приветствий для новых участников')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('ticket_channel')
            .setDescription('Канал тикетов для заявок на вступление')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Показать текущую конфигурацию приветствий'),
    )

    // ── reset ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Сбросить конкретную настройку')
        .addStringOption((opt) =>
          opt
            .setName('setting')
            .setDescription('Что сбросить')
            .setRequired(true)
            .addChoices(
              { name: '🎖️ Авто-роль', value: 'autoRoleId' },
              { name: '👤 Роль участника', value: 'memberRoleId' },
              { name: '📋 Роль кандидата', value: 'recruitRoleId' },
              { name: '📢 Канал приветствий', value: 'welcomeChannelId' },
              { name: '🎫 Канал тикетов', value: 'ticketChannelId' },
            ),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.welcome.description',
  cooldown: 3,

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: 'Эта команда доступна только на сервере.', ephemeral: true });
      return;
    }

    // Acknowledge before locale/config/Discord REST reads can consume the token.
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const locale = await getGuildLocale(interaction.guildId);

    // Все команды требуют ManageGuild
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.editReply({
        embeds: [errorEmbed(i18n.t('welcome.error_admin_only', locale))],
      });
      return;
    }

    switch (sub) {
      case 'setup':  await handleSetup(interaction, locale); break;
      case 'config': await handleConfig(interaction, locale); break;
      case 'reset':  await handleReset(interaction, locale); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  /welcome setup — partial update (как в других модулях)
// ═══════════════════════════════════════════════

async function handleSetup(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const guildId = interaction.guildId!;

  const autoRole    = interaction.options.getRole('auto_role') as Role | null;
  const memberRole  = interaction.options.getRole('member_role') as Role | null;
  const recruitRole = interaction.options.getRole('recruit_role') as Role | null;
  const welcomeCh   = interaction.options.getChannel('welcome_channel');
  const ticketCh    = interaction.options.getChannel('ticket_channel');

  // Если ничего не указано
  if (!autoRole && !memberRole && !recruitRole && !welcomeCh && !ticketCh) {
    await interaction.editReply({
      embeds: [errorEmbed(i18n.t('welcome.error_no_params', locale))],
    });
    return;
  }

  // Security-sensitive role configuration always uses force-refreshed actor,
  // bot and role hierarchy rather than the interaction/cache snapshots.
  const rolesToValidate: Array<{ role: Role; label: string; dangerousForbidden: boolean }> = [];
  if (autoRole) rolesToValidate.push({
    role: autoRole,
    label: i18n.t('welcome.choice_auto_role', locale),
    dangerousForbidden: true,
  });
  if (memberRole) rolesToValidate.push({
    role: memberRole,
    label: i18n.t('welcome.choice_member_role', locale),
    dangerousForbidden: false,
  });
  if (recruitRole) rolesToValidate.push({
    role: recruitRole,
    label: i18n.t('welcome.choice_recruit_role', locale),
    dangerousForbidden: true,
  });

  if (rolesToValidate.length > 0) {
    const context = await loadInteractionRolePolicyContext(interaction);
    if (!context || !interaction.guild) {
      await interaction.editReply({ embeds: [errorEmbed('Не удалось безопасно проверить права управления ролями.')] });
      return;
    }

    for (const { role, label, dangerousForbidden } of rolesToValidate) {
      const freshRole = await fetchRolePolicySubject(interaction.guild, role.id);
      const decision = evaluateRolePolicy(context, freshRole);
      if (!decision.ok) {
        await interaction.editReply({
          embeds: [errorEmbed(`${label}: ${rolePolicyFailureMessage(decision.reason)}`)],
        });
        return;
      }
      if (dangerousForbidden && freshRole && hasDangerousWelcomeRolePermissions(freshRole)) {
        await interaction.editReply({
          embeds: [errorEmbed(`${label}: автоматическая роль не может содержать административные или массово-управляющие права.`)],
        });
        return;
      }
    }
  }

  // Собираем только указанные параметры (partial update)
  const data: Record<string, any> = {};
  if (autoRole)    data.autoRoleId       = autoRole.id;
  if (memberRole)  data.memberRoleId     = memberRole.id;
  if (recruitRole) data.recruitRoleId    = recruitRole.id;
  if (welcomeCh)   data.welcomeChannelId = welcomeCh.id;
  if (ticketCh)    data.ticketChannelId  = ticketCh.id;

  const current = await getGuildConfig(guildId);
  const effectiveRoleIds = [
    data.autoRoleId ?? current.autoRoleId,
    data.memberRoleId ?? current.memberRoleId,
    data.recruitRoleId ?? current.recruitRoleId,
  ];
  if (!areWelcomeRoleIdsDistinct(effectiveRoleIds)) {
    await interaction.editReply({
      embeds: [errorEmbed('Авто-роль, роль участника и роль кандидата должны быть разными.')],
    });
    return;
  }

  if ((welcomeCh || ticketCh) && interaction.client.user) {
    const botMember = await interaction.guild!.members.fetch({
      user: interaction.client.user.id,
      force: true,
    });
    const channelChecks = [
      ...(welcomeCh ? [{
        id: welcomeCh.id,
        label: 'канал приветствий',
        required: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      }] : []),
      ...(ticketCh ? [{
        id: ticketCh.id,
        label: 'канал панели ADIR',
        required: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
        ],
      }] : []),
    ];
    for (const check of channelChecks) {
      const freshChannel = await interaction.guild!.channels.fetch(check.id);
      if (!freshChannel || !('permissionsFor' in freshChannel)) {
        await interaction.editReply({
          embeds: [errorEmbed(`Не удалось проверить ${check.label}.`)],
        });
        return;
      }
      if (!freshChannel.permissionsFor(botMember)?.has(check.required)) {
        await interaction.editReply({
          embeds: [errorEmbed(`В ${check.label} боту нужны View Channel, Send Messages и Embed Links${check.id === welcomeCh?.id ? ', а также Read Message History' : ''}.`)],
        });
        return;
      }
    }
  }

  await updateGuildConfig(guildId, data);

  // Перечитываем для актуальных данных
  const updated = await getGuildConfig(guildId);

  // Формируем ответ с пометками что изменилось ✏️
  const changed = (key: string) => data[key] !== undefined ? ' ✏️' : '';
  const fmt = (val: string | null, type: 'role' | 'channel') => {
    if (!val) return `\`${i18n.t('welcome.config_not_set', locale)}\``;
    return type === 'role' ? `<@&${val}>` : `<#${val}>`;
  };

  await interaction.editReply({
    embeds: [successEmbed(
      `${i18n.t('welcome.setup_success_title', locale)}\n\n` +
      `> ${i18n.t('welcome.setup_auto_role_label', locale)} ${fmt(updated.autoRoleId, 'role')}${changed('autoRoleId')}\n` +
      `> ${i18n.t('welcome.setup_member_role_label', locale)} ${fmt(updated.memberRoleId, 'role')}${changed('memberRoleId')}\n` +
      `> ${i18n.t('welcome.setup_recruit_role_label', locale)} ${fmt(updated.recruitRoleId, 'role')}${changed('recruitRoleId')}\n` +
      `> ${i18n.t('welcome.setup_welcome_channel_label', locale)} ${fmt(updated.welcomeChannelId, 'channel')}${changed('welcomeChannelId')}\n` +
      `> ${i18n.t('welcome.setup_ticket_channel_label', locale)} ${fmt(updated.ticketChannelId, 'channel')}${changed('ticketChannelId')}`,
    )],
  });

  log.info(`Welcome setup: ${interaction.guild?.name} [${Object.keys(data).join(', ')}]`);
}

// ═══════════════════════════════════════════════
//  /welcome config — показ текущих настроек
// ═══════════════════════════════════════════════

async function handleConfig(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const cfg = await getGuildConfig(interaction.guildId!);

  const fmt = (val: string | null, type: 'role' | 'channel') => {
    if (!val) return `\`${i18n.t('welcome.config_not_set', locale)}\``;
    return type === 'role' ? `<@&${val}>` : `<#${val}>`;
  };

  const embed = new BublikEmbed()
    .setColor(0x5865f2)
    .setAuthor({ name: i18n.t('welcome.config_author', locale) })
    .setDescription(
      `${i18n.t('welcome.config_roles_header', locale)}\n` +
      `> ${i18n.t('welcome.config_auto_role_line', locale)} ${fmt(cfg.autoRoleId, 'role')}\n` +
      `> ${i18n.t('welcome.config_member_role_line', locale)} ${fmt(cfg.memberRoleId, 'role')}\n` +
      `> ${i18n.t('welcome.config_recruit_role_line', locale)} ${fmt(cfg.recruitRoleId, 'role')}\n\n` +
      `${i18n.t('welcome.config_channels_header', locale)}\n` +
      `> ${i18n.t('welcome.config_welcome_channel_line', locale)} ${fmt(cfg.welcomeChannelId, 'channel')}\n` +
      `> ${i18n.t('welcome.config_ticket_channel_line', locale)} ${fmt(cfg.ticketChannelId, 'channel')}`,
    )
    .setFooter({ text: i18n.t('welcome.config_footer', locale) });

  await interaction.editReply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════
//  /welcome reset — сброс конкретной настройки
// ═══════════════════════════════════════════════

async function handleReset(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const setting = interaction.options.getString('setting', true);
  const guildId = interaction.guildId!;

  const labels: Record<string, string> = {
    autoRoleId: i18n.t('welcome.reset_label_auto_role', locale),
    memberRoleId: i18n.t('welcome.reset_label_member_role', locale),
    recruitRoleId: i18n.t('welcome.reset_label_recruit_role', locale),
    welcomeChannelId: i18n.t('welcome.reset_label_welcome_channel', locale),
    ticketChannelId: i18n.t('welcome.reset_label_ticket_channel', locale),
  };

  await updateGuildConfig(guildId, { [setting]: null });

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('welcome.reset_success', locale, { label: labels[setting] }))],
  });

  log.info(`Welcome reset: ${interaction.guild?.name} → ${setting}`);
}

export default welcomeCommand;
