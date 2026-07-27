// ═══════════════════════════════════════════════
//  /vacation — Админская команда управления отпусками
//
//  Субкоманды:
//  • setup     — первичная настройка (каналы, роль)
//  • panel     — развернуть панель в канале
//  • addrole   — добавить роль (remove/reviewer/ping)
//  • removerole— убрать роль
//  • force     — принудительный отпуск (обход прайм-тайма)
//  • return    — принудительный возврат
//  • primetime — настройка прайм-тайма
//  • config    — показать текущую конфигурацию
//  • list      — список активных/ожидающих отпусков
//  • antiabuse — настройка антиабьюза (кулдаун, лимиты)
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { BublikClient } from '../../../bot';
import { Config } from '../../../config';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getRedis } from '../../../core/Redis';
import { getDatabase } from '../../../core/Database';
import { getCompleteGuildMembers } from '../../../core/GuildMemberSnapshot';
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
  getActiveVacation,
  getGuildActiveVacations,
  reserveForcedVacation,
  transitionRequest,
} from '../database';
import {
  parseDuration,
  formatDuration,
  formatDateMsk,
  formatTimeLeft,
  snapshotVacationRoles,
} from '../utils';
import { activateVacation, restoreVacation } from '../saga';
import {
  buildPanelEmbed,
  buildPanelButtons,
  buildNsMainButton,
  buildNsPanelEmbed,
  buildNsPanelButtons,
  buildVacationStartLog,
  buildVacationEndLog,
} from '../embeds';
import { VacationStatus, VacationType } from '../constants';
import { fetchGuildMemberIfPresent } from '../../../utils/helpers';
import {
  vacationRoleChangeRequested,
  vacationRoleConfigurationIsDistinct,
} from '../state';
import { withVacationRoleConfigLock } from '../roleConfigLock';

const log = logger.child('Vacation:Command');

async function ensureRoleMutationAllowed(
  interaction: ChatInputCommandInteraction,
  roleIds: readonly string[],
  options: { editReply?: boolean; skipMissing?: boolean; rejectDangerous?: boolean } = {},
): Promise<boolean> {
  const context = await loadInteractionRolePolicyContext(interaction);
  let failure: ReturnType<typeof evaluateRolePolicy> | null = null;

  if (!context || !interaction.guild) {
    failure = { ok: false, reason: 'wrong_guild' };
  } else {
    for (const roleId of new Set(roleIds)) {
      const role = await fetchRolePolicySubject(interaction.guild, roleId);
      if (!role && options.skipMissing) continue;
      const decision = evaluateRolePolicy(context, role);
      if (!decision.ok) {
        failure = decision;
        break;
      }
      if (options.rejectDangerous && role && hasDangerousAssignablePermissions(role.permissions)) {
        const embed = errorEmbed('Автоматически выдаваемая роль не может содержать административные права.');
        if (options.editReply) await interaction.editReply({ embeds: [embed] });
        else await interaction.reply({ embeds: [embed], ephemeral: true });
        return false;
      }
    }
  }

  if (!failure || failure.ok) return true;
  const embed = errorEmbed(rolePolicyFailureMessage(failure.reason));
  if (options.editReply) {
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  return false;
}

const vacationCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('vacation')
    .setDescription('Управление системой отпусков')

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить / изменить систему отпусков')
        .addChannelOption((opt) =>
          opt
            .setName('review')
            .setDescription('Канал для заявок на отпуск')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('log')
            .setDescription('Канал для логов (уход/возврат)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Роль, выдаваемая в отпуске')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_days')
            .setDescription('Максимальная длительность отпуска (дни)')
            .setMinValue(1)
            .setMaxValue(365)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('quick_hours')
            .setDescription('Длительность «Не смогу сегодня» (часы)')
            .setMinValue(1)
            .setMaxValue(72)
            .setRequired(false),
        ),
    )

    // ── panel ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Развернуть панель отпусков в канале')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал для панели')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('image')
            .setDescription('URL картинки для панели')
            .setRequired(false),
        ),
    )

    // ── addrole ───────────────────
    .addSubcommand((sub) =>
      sub
        .setName('addrole')
        .setDescription('Добавить роль в конфигурацию')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🔄 Снимаемая (remove)', value: 'remove' },
              { name: '👮 Проверяющая (reviewer)', value: 'reviewer' },
              { name: '🔔 Уведомляемая (ping)', value: 'ping' },
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
        .setDescription('Убрать роль из конфигурации')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Тип роли')
            .setRequired(true)
            .addChoices(
              { name: '🔄 Снимаемая (remove)', value: 'remove' },
              { name: '👮 Проверяющая (reviewer)', value: 'reviewer' },
              { name: '🔔 Уведомляемая (ping)', value: 'ping' },
            ),
        )
        .addRoleOption((opt) =>
          opt.setName('role').setDescription('Роль').setRequired(true),
        ),
    )

    // ── force ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('force')
        .setDescription('Принудительный отпуск (обход прайм-тайма)')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Участник').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('duration')
            .setDescription('Длительность (3d, 2w, 1mo, 30m)')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('reason')
            .setDescription('Причина')
            .setRequired(false),
        ),
    )

    // ── return ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('return')
        .setDescription('Принудительный возврат из отпуска')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Участник').setRequired(true),
        ),
    )

    // ── primetime ─────────────────
    .addSubcommand((sub) =>
      sub
        .setName('primetime')
        .setDescription('Настроить прайм-тайм')
        .addIntegerOption((opt) =>
          opt
            .setName('start')
            .setDescription('Начало прайм-тайма (час МСК, 0-23)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('end')
            .setDescription('Конец прайм-тайма (час МСК, 0-23)')
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('buffer')
            .setDescription('Блокировка за N часов до прайм-тайма')
            .setMinValue(0)
            .setMaxValue(6)
            .setRequired(false),
        ),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Показать текущую конфигурацию'),
    )

    // ── list ──────────────────────
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Список активных и ожидающих отпусков'),
    )

    // ── antiabuse ─────────────────
    .addSubcommand((sub) =>
      sub
        .setName('antiabuse')
        .setDescription('Настроить антиабьюз (кулдаун, лимиты)')
        .addIntegerOption((opt) =>
          opt
            .setName('cooldown')
            .setDescription('Дней кулдауна после возврата из отпуска (0 = отключить)')
            .setMinValue(0)
            .setMaxValue(90)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_per_month')
            .setDescription('Макс. отпусков за 30 дней (0 = без лимита)')
            .setMinValue(0)
            .setMaxValue(30)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max_quick_per_week')
            .setDescription('Макс. быстрых отпусков за 7 дней (0 = без лимита)')
            .setMinValue(0)
            .setMaxValue(14)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('auto_deny_hours')
            .setDescription('Часов до автоотклонения заявки без ответа ревьюера (1–48)')
            .setMinValue(1)
            .setMaxValue(48)
            .setRequired(false),
        ),
    )

    // ── ns_panel ──────────────────
    .addSubcommand((sub) =>
      sub
        .setName('ns_panel')
        .setDescription('Развернуть панель отпуска Небесных Стражей')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал для панели НС')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.vacation.description',
  cooldown: 3,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const locale = await getGuildLocale(interaction.guildId);

    // Базовое администрирование требует ManageGuild. Любая команда, способная
    // настроить или фактически изменить роли, дополнительно требует ManageRoles.
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('vacation.error_admin_only', locale))],
        ephemeral: true,
      });
      return;
    }
    const roleMutationSubs = new Set(['setup', 'addrole', 'removerole', 'force', 'return']);
    if (roleMutationSubs.has(sub) && !perms.has(PermissionsBitField.Flags.ManageRoles)) {
      await interaction.reply({
        embeds: [errorEmbed('Для этой операции требуется право «Управлять ролями».')],
        ephemeral: true,
      });
      return;
    }

    switch (sub) {
      case 'setup':      await handleSetup(interaction, client, locale); break;
      case 'panel':      await handlePanel(interaction, client, locale); break;
      case 'addrole':    await handleAddRole(interaction, locale); break;
      case 'removerole': await handleRemoveRole(interaction, locale); break;
      case 'force':      await handleForce(interaction, client, locale); break;
      case 'return':     await handleReturn(interaction, client, locale); break;
      case 'primetime':  await handlePrimeTime(interaction, locale); break;
      case 'config':     await handleConfig(interaction, locale); break;
      case 'list':       await handleList(interaction, locale); break;
      case 'antiabuse':  await handleAntiAbuse(interaction, locale); break;
      case 'ns_panel':   await handleNsPanel(interaction, client, locale); break;
    }
  },
};

// ═══════════════════════════════════════════════
//  /vacation setup
// ═══════════════════════════════════════════════

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const guildId = interaction.guildId!;
  const existing = await getConfig(guildId);

  const reviewChannel = interaction.options.getChannel('review');
  const logChannel = interaction.options.getChannel('log');
  const role = interaction.options.getRole('role');
  const maxDays = interaction.options.getInteger('max_days');
  const quickHours = interaction.options.getInteger('quick_hours');

  if (role && !(await ensureRoleMutationAllowed(interaction, [role.id], { rejectDangerous: true }))) return;

  // Первичная настройка — требуем обязательные параметры
  if (!existing && (!reviewChannel || !logChannel || !role)) {
    await interaction.reply({
      embeds: [errorEmbed(
        i18n.t('vacation.error_setup_required_full', locale),
      )],
      ephemeral: true,
    });
    return;
  }

  // Проверка: review канал не должен совпадать с panel каналом
  const newReviewId = reviewChannel?.id ?? existing?.reviewChannelId;
  if (newReviewId && existing?.panelChannelId && newReviewId === existing.panelChannelId) {
    await interaction.reply({
      embeds: [errorEmbed(
        i18n.t('vacation.error_review_equals_panel', locale, { channelId: existing.panelChannelId }),
      )],
      ephemeral: true,
    });
    return;
  }

  // Собираем только указанные параметры
  const data: Record<string, any> = {};
  if (reviewChannel) data.reviewChannelId = reviewChannel.id;
  if (logChannel) data.logChannelId = logChannel.id;
  if (role) data.vacationRoleId = role.id;
  if (maxDays !== null) data.maxDurationDays = maxDays;
  if (quickHours !== null) data.quickDurationH = quickHours;

  type SetupMutationResult =
    | { ok: true; config: Awaited<ReturnType<typeof upsertConfig>>; isNew: boolean }
    | { ok: false; reason: 'collision' | 'live' | 'holders'; count?: number };

  let mutation: SetupMutationResult;
  if (role) {
    // A complete member snapshot can require a gateway chunk request. Acknowledge
    // the interaction before entering the serialized scan/update section.
    await interaction.deferReply({ ephemeral: true });
    mutation = await withVacationRoleConfigLock<SetupMutationResult>(
      guildId,
      async (configLock) => {
        const freshExisting = await getDatabase().vacationConfig.findUnique({
          where: { guildId },
        });
        const regbattle = await getDatabase().regbattleConfig.findUnique({
          where: { guildId },
          select: {
            pingRoleId: true,
            inSquadRoleId: true,
            playedTodayRoleId: true,
            reprimandTypeRoleIds: true,
          },
        });
        if (
          !vacationRoleConfigurationIsDistinct(role.id, [
            regbattle?.pingRoleId ?? null,
            regbattle?.inSquadRoleId ?? null,
            regbattle?.playedTodayRoleId ?? null,
          ], freshExisting?.removeRoleIds ?? []) ||
          regbattle?.reprimandTypeRoleIds.includes(role.id)
        ) {
          return { ok: false, reason: 'collision' };
        }

        const previousVacationRoleId = freshExisting?.vacationRoleId ?? null;
        if (vacationRoleChangeRequested(previousVacationRoleId, role.id)) {
          if (!freshExisting || !previousVacationRoleId) {
            throw new Error('Vacation role change lost its configuration snapshot');
          }
          const liveCount = await getDatabase().vacationRequest.count({
            where: {
              configId: freshExisting.id,
              status: { in: [
                VacationStatus.Activating,
                VacationStatus.Active,
                VacationStatus.Restoring,
              ] },
            },
          });
          if (liveCount > 0) return { ok: false, reason: 'live', count: liveCount };

          const guild = interaction.guild;
          if (!guild) throw new Error('Vacation setup requires a guild');
          const members = await getCompleteGuildMembers(guild);
          const oldRoleHolderCount = members.filter((member) =>
            member.roles.cache.has(previousVacationRoleId)).size;
          if (oldRoleHolderCount > 0) {
            return { ok: false, reason: 'holders', count: oldRoleHolderCount };
          }
        }

        await configLock.assertOwned();
        return {
          ok: true,
          config: await upsertConfig(guildId, data),
          isNew: !freshExisting,
        };
      },
    );
  } else {
    const finalVacationRoleId = existing?.vacationRoleId ?? null;
    const regbattle = finalVacationRoleId
      ? await getDatabase().regbattleConfig.findUnique({
        where: { guildId },
        select: {
          pingRoleId: true,
          inSquadRoleId: true,
          playedTodayRoleId: true,
          reprimandTypeRoleIds: true,
        },
      })
      : null;
    if (
      finalVacationRoleId && (
        !vacationRoleConfigurationIsDistinct(finalVacationRoleId, [
          regbattle?.pingRoleId ?? null,
          regbattle?.inSquadRoleId ?? null,
          regbattle?.playedTodayRoleId ?? null,
        ], existing?.removeRoleIds ?? []) ||
        regbattle?.reprimandTypeRoleIds.includes(finalVacationRoleId)
      )
    ) {
      mutation = { ok: false, reason: 'collision' };
    } else {
      mutation = {
        ok: true,
        config: await upsertConfig(guildId, data),
        isNew: !existing,
      };
    }
  }

  if (!mutation.ok) {
    let embed;
    if (mutation.reason === 'live') {
      embed = errorEmbed(i18n.t('vacation.error_role_change_live', locale, {
        count: mutation.count ?? 0,
      }));
    } else if (mutation.reason === 'holders') {
      embed = errorEmbed(i18n.t('vacation.error_role_change_holders', locale, {
        count: mutation.count ?? 0,
      }));
    } else {
      embed = errorEmbed(i18n.t('vacation.error_role_conflicts_pb_or_remove', locale));
    }
    if (interaction.deferred) await interaction.editReply({ embeds: [embed] });
    else await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const { config, isNew } = mutation;

  // Формируем ответ с пометками что изменилось
  const changed = (key: string) => data[key] !== undefined ? ' ✏️' : '';

  const statusText = isNew
    ? i18n.t('vacation.success_setup_status_new', locale)
    : i18n.t('vacation.success_setup_status_updated', locale);

  const response = {
    embeds: [successEmbed(
      `🏖️ **${i18n.t('vacation.cmd.description', locale)} ${statusText}!**\n\n` +
      `> 📋 **${i18n.t('vacation.config_review_channel', locale, { value: `<#${config.reviewChannelId}>` })}**${changed('reviewChannelId')}\n` +
      `> 📝 **${i18n.t('vacation.config_log_channel', locale, { value: `<#${config.logChannelId}>` })}**${changed('logChannelId')}\n` +
      `> 🏖️ **${i18n.t('vacation.config_vacation_role', locale, { value: `<@&${config.vacationRoleId}>` })}**${changed('vacationRoleId')}\n` +
      `> ${i18n.t('vacation.config_max_duration', locale, { days: String(config.maxDurationDays) })}${changed('maxDurationDays')}\n` +
      `> ${i18n.t('vacation.config_quick_duration', locale, { hours: String(config.quickDurationH) })}${changed('quickDurationH')}\n` +
      (isNew ? `\n${i18n.t('vacation.success_setup_next_steps', locale)}` : ''),
    )],
  };
  if (interaction.deferred) await interaction.editReply(response);
  else await interaction.reply({ ...response, ephemeral: true });

  log.info(`Vacation setup: ${interaction.guild?.name}`);
}

// ═══════════════════════════════════════════════
//  /vacation panel
// ═══════════════════════════════════════════════

async function handlePanel(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const channel = interaction.options.getChannel('channel', true) as TextChannel;
  const imageUrl = interaction.options.getString('image');

  const guildId = interaction.guildId!;
  let config = await getConfig(guildId);

  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_setup_first', locale))],
      ephemeral: true,
    });
    return;
  }

  // Панель не должна быть в канале заявок
  if (config.reviewChannelId && channel.id === config.reviewChannelId) {
    await interaction.reply({
      embeds: [errorEmbed(
        i18n.t('vacation.error_panel_in_review', locale, { channelId: config.reviewChannelId }),
      )],
      ephemeral: true,
    });
    return;
  }

  // Обновить imageUrl если указан
  if (imageUrl) {
    config = await upsertConfig(guildId, { imageUrl });
  }

  await interaction.deferReply({ ephemeral: true });

  // Если панель уже есть в этом канале — попробовать обновить
  if (config.panelMessageId && config.panelChannelId === channel.id) {
    try {
      const existing = await channel.messages.fetch(config.panelMessageId);
      await existing.edit({
        embeds: [buildPanelEmbed(config, locale)],
        components: [buildPanelButtons(locale), buildNsMainButton(locale)],
      });
      await interaction.editReply({
        embeds: [successEmbed(i18n.t('vacation.success_panel_updated', locale))],
      });
      return;
    } catch {
      // Сообщение удалено — отправим новое
    }
  }

  // Удалить старую панель если в другом канале
  if (config.panelMessageId && config.panelChannelId && config.panelChannelId !== channel.id) {
    try {
      const oldChannel = await client.channels.fetch(config.panelChannelId) as TextChannel;
      await oldChannel.messages.delete(config.panelMessageId).catch(() => null);
    } catch { /* skip */ }
  }

  // Отправить новую панель
  const msg = await channel.send({
    embeds: [buildPanelEmbed(config, locale)],
    components: [buildPanelButtons(locale), buildNsMainButton(locale)],
  });

  await upsertConfig(guildId, {
    panelChannelId: channel.id,
    panelMessageId: msg.id,
  });

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('vacation.success_panel_deployed', locale, { channelId: channel.id }))],
  });

  log.info(`Панель отпусков развёрнута: ${channel.name}`);
}

// ═══════════════════════════════════════════════
//  /vacation addrole
// ═══════════════════════════════════════════════

async function handleAddRole(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  if (!(await ensureRoleMutationAllowed(interaction, [role.id]))) return;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('vacation.error_setup_first', locale))], ephemeral: true });
    return;
  }

  if (type === 'remove' && role.id === config.vacationRoleId) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_role_conflicts_pb_or_remove', locale))],
      ephemeral: true,
    });
    return;
  }

  const fieldMap: Record<string, string> = {
    remove: 'removeRoleIds',
    reviewer: 'reviewerRoleIds',
    ping: 'pingRoleIds',
  };
  const field = fieldMap[type] as 'removeRoleIds' | 'reviewerRoleIds' | 'pingRoleIds';
  const current: string[] = config[field];

  if (current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('vacation.error_role_already_in_list', locale, { roleId: role.id }))], ephemeral: true });
    return;
  }

  let updated: string[];
  if (type === 'remove') {
    await interaction.deferReply({ ephemeral: true });
    const mutation = await withVacationRoleConfigLock(guildId, async (configLock) => {
      const freshConfig = await getDatabase().vacationConfig.findUnique({
        where: { guildId },
      });
      if (!freshConfig) throw new Error('Vacation configuration disappeared');
      if (freshConfig.vacationRoleId === role.id) return null;
      if (freshConfig.removeRoleIds.includes(role.id)) {
        return { alreadyConfigured: true } as const;
      }
      const next = [...freshConfig.removeRoleIds, role.id];
      await configLock.assertOwned();
      await upsertConfig(guildId, { removeRoleIds: next });
      return { updated: next } as const;
    });
    if (!mutation) {
      await interaction.editReply({
        embeds: [errorEmbed(i18n.t('vacation.error_role_conflicts_pb_or_remove', locale))],
      });
      return;
    }
    if ('alreadyConfigured' in mutation) {
      await interaction.editReply({
        embeds: [errorEmbed(i18n.t('vacation.error_role_already_in_list', locale, { roleId: role.id }))],
      });
      return;
    }
    updated = mutation.updated;
  } else {
    updated = [...current, role.id];
    await upsertConfig(guildId, { [field]: updated });
  }

  const typeLabels: Record<string, string> = {
    remove: i18n.t('vacation.role_type_remove', locale),
    reviewer: i18n.t('vacation.role_type_reviewer', locale),
    ping: i18n.t('vacation.role_type_ping', locale),
  };

  const list = updated.map((id) => `<@&${id}>`).join(', ');
  const response = {
    embeds: [successEmbed(
      i18n.t('vacation.success_role_added', locale, { roleId: role.id, typeLabel: typeLabels[type], list }),
    )],
  };
  if (interaction.deferred) await interaction.editReply(response);
  else await interaction.reply({ ...response, ephemeral: true });
}

// ═══════════════════════════════════════════════
//  /vacation removerole
// ═══════════════════════════════════════════════

async function handleRemoveRole(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const type = interaction.options.getString('type', true);
  const role = interaction.options.getRole('role', true);
  const guildId = interaction.guildId!;

  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('vacation.error_setup_first', locale))], ephemeral: true });
    return;
  }

  const fieldMap: Record<string, string> = {
    remove: 'removeRoleIds',
    reviewer: 'reviewerRoleIds',
    ping: 'pingRoleIds',
  };
  const field = fieldMap[type] as 'removeRoleIds' | 'reviewerRoleIds' | 'pingRoleIds';
  const current: string[] = config[field];

  if (!current.includes(role.id)) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('vacation.error_role_not_in_list', locale, { roleId: role.id }))], ephemeral: true });
    return;
  }

  const updated = current.filter((id) => id !== role.id);
  await upsertConfig(guildId, { [field]: updated });

  const typeLabels: Record<string, string> = {
    remove: i18n.t('vacation.role_type_remove', locale),
    reviewer: i18n.t('vacation.role_type_reviewer', locale),
    ping: i18n.t('vacation.role_type_ping', locale),
  };

  const list = updated.length > 0 ? updated.map((id) => `<@&${id}>`).join(', ') : i18n.t('vacation.log_no_roles', locale);
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('vacation.success_role_removed', locale, { roleId: role.id, typeLabel: typeLabels[type], list }),
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation force — принудительный отпуск
// ═══════════════════════════════════════════════

async function handleForce(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const durationStr = interaction.options.getString('duration', true);
  const reason = interaction.options.getString('reason') ?? i18n.t('vacation.force_default_reason', locale);

  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed(i18n.t('vacation.error_not_configured', locale))], ephemeral: true });
    return;
  }

  const durationMinutes = parseDuration(durationStr);
  if (!durationMinutes) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_bad_duration_force', locale))],
      ephemeral: true,
    });
    return;
  }

  // Жёсткий лимит даже для force (защита от опечаток типа 12m вместо 12min)
  const MAX_FORCE_DAYS = 365;
  if (durationMinutes > MAX_FORCE_DAYS * 24 * 60) {
    await interaction.reply({
      embeds: [errorEmbed(
        i18n.t('vacation.error_force_max_duration', locale, {
          days: String(MAX_FORCE_DAYS),
          duration: formatDuration(durationMinutes),
        }),
      )],
      ephemeral: true,
    });
    return;
  }

  // Проверить, не в отпуске ли уже
  const active = await getActiveVacation(guildId, targetUser.id);
  if (active) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_already_on_vacation_target', locale, { userId: targetUser.id, date: formatDateMsk(active.endDate!) }))],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const lockKey = `vac:force:lock:${guildId}:${targetUser.id}`;
  const lockToken = randomUUID();
  const locked = await getRedis().set(lockKey, lockToken, 'EX', 30, 'NX');
  if (!locked) {
    await interaction.editReply({ embeds: [errorEmbed(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  try {
    // Повторная проверка в критической секции
    const activeNow = await getActiveVacation(guildId, targetUser.id);
    if (activeNow) {
      await interaction.editReply({
        embeds: [errorEmbed(i18n.t('vacation.error_already_on_vacation_target', locale, { userId: targetUser.id, date: formatDateMsk(activeNow.endDate!) }))],
      });
      return;
    }

    const guild = interaction.guild!;
    const member = await fetchGuildMemberIfPresent(guild, targetUser.id);
    if (!member) {
      await interaction.editReply({ embeds: [errorEmbed(i18n.t('vacation.error_member_not_found', locale))] });
      return;
    }

    const now = new Date();
    const endDate = new Date(now.getTime() + durationMinutes * 60_000);

    const savedRoles = await snapshotVacationRoles(member, config);
    const regbattle = await getDatabase().regbattleConfig.findUnique({
      where: { guildId },
      select: { pingRoleId: true },
    });
    if (config.vacationRoleId && !(await ensureRoleMutationAllowed(
      interaction,
      [config.vacationRoleId],
      { editReply: true, rejectDangerous: true },
    ))) return;
    const forceRoleIds = [
      ...savedRoles,
      regbattle?.pingRoleId,
    ].filter((roleId): roleId is string => Boolean(roleId));
    if (!(await ensureRoleMutationAllowed(interaction, forceRoleIds, { editReply: true, skipMissing: true }))) {
      return;
    }

    // В одной транзакции либо преобразуем pending, либо резервируем новую запись.
    const reserved = await reserveForcedVacation({
      guildId,
      userId: targetUser.id,
      type: VacationType.Admin,
      reason,
      durationMinutes,
      status: VacationStatus.Activating,
      startDate: now,
      endDate,
      savedRoleIds: savedRoles,
      configId: config.id,
      reviewerId: interaction.user.id,
    });
    if (!reserved) {
      await interaction.editReply({ embeds: [errorEmbed(i18n.t('vacation.error_already_processing', locale))] });
      return;
    }
    const request = await activateVacation(reserved, member);

    // Лог
    if (config.logChannelId) {
      try {
        const logChannel = await client.channels.fetch(config.logChannelId) as TextChannel;
        await logChannel.send({ embeds: [buildVacationStartLog(member, request, savedRoles, locale)] });
      } catch { /* skip */ }
    }

    // DM
    await member.send({
      embeds: [successEmbed(
        i18n.t('vacation.dm_force', locale, {
          reason,
          duration: formatDuration(durationMinutes),
          date: formatDateMsk(endDate),
        }),
      )],
    }).catch(() => null);

    await interaction.editReply({
      embeds: [successEmbed(
        i18n.t('vacation.success_force', locale, {
          member: member.toString(),
          reason,
          duration: formatDuration(durationMinutes),
          date: formatDateMsk(endDate),
        }),
      )],
    });

    log.info(`Принудительный отпуск: ${member.user.tag} — ${formatDuration(durationMinutes)} (admin: ${interaction.user.tag})`);
  } finally {
    await getRedis().eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      lockKey,
      lockToken,
    ).catch(() => null);
  }
}

// ═══════════════════════════════════════════════
//  /vacation return — принудительный возврат
// ═══════════════════════════════════════════════

async function handleReturn(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;

  const active = await getActiveVacation(guildId, targetUser.id);
  if (!active) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_target_not_on_vacation', locale, { userId: targetUser.id }))],
      ephemeral: true,
    });
    return;
  }

  const returnRoleIds = [
    ...active.savedRoleIds,
    active.config.vacationRoleId,
  ].filter((roleId): roleId is string => Boolean(roleId));
  if (!(await ensureRoleMutationAllowed(interaction, returnRoleIds, { skipMissing: true }))) return;

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const member = await fetchGuildMemberIfPresent(guild, targetUser.id);

  // Зафиксировать реальную дату окончания и эксклюзивно захватить восстановление.
  const claimed = await transitionRequest(active.id, VacationStatus.Active, {
    status: VacationStatus.Restoring,
    endDate: new Date(),
  }, active.updatedAt);
  if (!claimed) {
    await interaction.editReply({ embeds: [errorEmbed(i18n.t('vacation.error_already_processing', locale))] });
    return;
  }

  const updated = member
    ? await restoreVacation(claimed, member)
    : await transitionRequest(claimed.id, VacationStatus.Restoring, { status: VacationStatus.Completed });
  if (!updated) {
    throw new Error(`Vacation ${active.id} completion CAS lost`);
  }

  // Лог
  if (active.config.logChannelId && member) {
    try {
      const logChannel = await client.channels.fetch(active.config.logChannelId) as TextChannel;
      await logChannel.send({ embeds: [buildVacationEndLog(member, updated, true, locale)] });
    } catch { /* skip */ }
  }

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('vacation.success_force_return', locale, { user: targetUser.toString() }))],
  });

  log.info(`Принудительный возврат: ${targetUser.tag} (admin: ${interaction.user.tag})`);
}

// ═══════════════════════════════════════════════
//  /vacation primetime
// ═══════════════════════════════════════════════

async function handlePrimeTime(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const start = interaction.options.getInteger('start', true);
  const end = interaction.options.getInteger('end', true);
  const buffer = interaction.options.getInteger('buffer') ?? 1;

  // Защита: start == end с buffer=0 блокирует отпуска 24/7
  if (start === end) {
    await interaction.reply({
      embeds: [errorEmbed(
        i18n.t('vacation.error_primetime_same', locale),
      )],
      ephemeral: true,
    });
    return;
  }

  await upsertConfig(interaction.guildId!, {
    primeTimeStart: start,
    primeTimeEnd: end,
    primeTimeBuffer: buffer,
  });

  const blockStart = (start - buffer + 24) % 24;
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('vacation.success_primetime', locale, {
        start: String(start).padStart(2, '0'),
        end: String(end).padStart(2, '0'),
        blockStart: String(blockStart).padStart(2, '0'),
        buffer: String(buffer),
      }),
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation config
// ═══════════════════════════════════════════════

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const config = await getConfig(interaction.guildId!);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_not_configured_setup', locale))],
      ephemeral: true,
    });
    return;
  }

  const removeRoles = config.removeRoleIds.length > 0
    ? config.removeRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : i18n.t('vacation.config_not_set_plural', locale);
  const reviewerRoles = config.reviewerRoleIds.length > 0
    ? config.reviewerRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : i18n.t('vacation.config_not_set_plural', locale);
  const pingRoles = config.pingRoleIds.length > 0
    ? config.pingRoleIds.map((id: string) => `<@&${id}>`).join(', ')
    : i18n.t('vacation.config_not_set_plural', locale);

  const blockStart = (config.primeTimeStart - config.primeTimeBuffer + 24) % 24;

  await interaction.reply({
    embeds: [successEmbed(
      `${i18n.t('vacation.config_title', locale)}\n\n` +
      `> ${i18n.t('vacation.config_review_channel', locale, { value: config.reviewChannelId ? `<#${config.reviewChannelId}>` : i18n.t('vacation.config_not_set_masc', locale) })}\n` +
      `> ${i18n.t('vacation.config_log_channel', locale, { value: config.logChannelId ? `<#${config.logChannelId}>` : i18n.t('vacation.config_not_set_masc', locale) })}\n` +
      `> ${i18n.t('vacation.config_vacation_role', locale, { value: config.vacationRoleId ? `<@&${config.vacationRoleId}>` : i18n.t('vacation.config_not_set_fem', locale) })}\n` +
      `> ${i18n.t('vacation.config_remove_roles', locale, { value: removeRoles })}\n` +
      `> ${i18n.t('vacation.config_reviewer_roles', locale, { value: reviewerRoles })}\n` +
      `> ${i18n.t('vacation.config_ping_roles', locale, { value: pingRoles })}\n` +
      `> ${i18n.t('vacation.config_max_duration', locale, { days: String(config.maxDurationDays) })}\n` +
      `> ${i18n.t('vacation.config_quick_duration', locale, { hours: String(config.quickDurationH) })}\n` +
      `> ${i18n.t('vacation.config_primetime', locale, { start: String(config.primeTimeStart).padStart(2, '0'), end: String(config.primeTimeEnd).padStart(2, '0') })}\n` +
      `> ${i18n.t('vacation.config_block_from', locale, { blockStart: String(blockStart).padStart(2, '0') })}\n\n` +
      `${i18n.t('vacation.config_antiabuse_title', locale)}\n` +
      `> ${i18n.t('vacation.config_cooldown', locale, { days: String(config.cooldownDays) })}\n` +
      `> ${i18n.t('vacation.config_max_month', locale, { value: config.maxPerMonth ? String(config.maxPerMonth) : '\u221e' })}\n` +
      `> ${i18n.t('vacation.config_max_quick_week', locale, { value: config.maxQuickPerWeek ? String(config.maxQuickPerWeek) : '\u221e' })}\n` +
      `> ${i18n.t('vacation.config_auto_deny', locale, { hours: String((config as any).autoDenyHours ?? 8) })}`,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation list
// ═══════════════════════════════════════════════

async function handleList(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const vacations = await getGuildActiveVacations(interaction.guildId!);

  if (vacations.length === 0) {
    await interaction.reply({
      embeds: [successEmbed(i18n.t('vacation.list_empty', locale))],
      ephemeral: true,
    });
    return;
  }

  const active = vacations.filter((v: any) => v.status === VacationStatus.Active);
  const pending = vacations.filter((v: any) => v.status === VacationStatus.Pending);

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(`${i18n.t('vacation.list_active_title', locale)}\n`);
    for (const v of active) {
      const left = formatTimeLeft(v.endDate!);
      const typeIcon = v.type === 'quick' ? '⚡' : v.type === 'admin' ? '👮' : '🏖️';
      lines.push(
        `${typeIcon} <@${v.userId}> — ${i18n.t('vacation.approved_until', locale, { date: formatDateMsk(v.endDate!) })} (${left})\n` +
        `> 📝 ${v.reason}`,
      );
    }
  }

  if (pending.length > 0) {
    if (active.length > 0) lines.push('');
    lines.push(`${i18n.t('vacation.list_pending_title', locale)}\n`);
    for (const v of pending) {
      lines.push(
        `📋 <@${v.userId}> — ${formatDuration(v.durationMinutes)}\n` +
        `> 📝 ${v.reason}`,
      );
    }
  }

  let description = lines.join('\n');

  // Защита от превышения лимита Discord (4096 символов)
  const header = `${i18n.t('vacation.list_header', locale, { count: String(vacations.length) })}\n\n`;
  const maxLen = 4096 - header.length - 50; // запас для "..."
  if (description.length > maxLen) {
    description = description.slice(0, maxLen) + `\n\n${i18n.t('vacation.list_overflow', locale)}`;
  }

  await interaction.reply({
    embeds: [successEmbed(`${header}${description}`)],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /vacation antiabuse — настройка антиабьюза
// ═══════════════════════════════════════════════

async function handleAntiAbuse(
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const guildId = interaction.guildId!;
  const config = await getConfig(guildId);
  if (!config) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.error_not_configured_setup', locale))],
      ephemeral: true,
    });
    return;
  }

  const cooldown = interaction.options.getInteger('cooldown');
  const maxPerMonth = interaction.options.getInteger('max_per_month');
  const maxQuickPerWeek = interaction.options.getInteger('max_quick_per_week');
  const autoDenyHours = interaction.options.getInteger('auto_deny_hours');

  // Если ничего не указано — показать текущие настройки
  if (cooldown === null && maxPerMonth === null && maxQuickPerWeek === null && autoDenyHours === null) {
    await interaction.reply({
      embeds: [successEmbed(
        `${i18n.t('vacation.antiabuse_current_title', locale)}\n\n` +
        `> ${i18n.t('vacation.antiabuse_cooldown', locale, { days: String(config.cooldownDays) })}\n` +
        `> ${i18n.t('vacation.antiabuse_max_month', locale, { value: config.maxPerMonth ? String(config.maxPerMonth) : i18n.t('vacation.antiabuse_no_limit', locale) })}\n` +
        `> ${i18n.t('vacation.antiabuse_max_quick', locale, { value: config.maxQuickPerWeek ? String(config.maxQuickPerWeek) : i18n.t('vacation.antiabuse_no_limit', locale) })}\n` +
        `> ${i18n.t('vacation.antiabuse_auto_deny', locale, { hours: String((config as any).autoDenyHours ?? 8) })}\n\n` +
        i18n.t('vacation.antiabuse_hint', locale),
      )],
      ephemeral: true,
    });
    return;
  }

  const updateData: Record<string, number> = {};
  if (cooldown !== null) updateData.cooldownDays = cooldown;
  if (maxPerMonth !== null) updateData.maxPerMonth = maxPerMonth;
  if (maxQuickPerWeek !== null) updateData.maxQuickPerWeek = maxQuickPerWeek;
  if (autoDenyHours !== null) updateData.autoDenyHours = autoDenyHours;

  const updated = await upsertConfig(guildId, updateData);

  await interaction.reply({
    embeds: [successEmbed(
      `${i18n.t('vacation.antiabuse_updated_title', locale)}\n\n` +
      `> ${i18n.t('vacation.config_cooldown', locale, { days: String(updated.cooldownDays) })}${cooldown !== null ? ' ✏️' : ''}\n` +
      `> ${i18n.t('vacation.config_max_month', locale, { value: updated.maxPerMonth ? String(updated.maxPerMonth) : '∞' })}${maxPerMonth !== null ? ' ✏️' : ''}\n` +
      `> ${i18n.t('vacation.config_max_quick_week', locale, { value: updated.maxQuickPerWeek ? String(updated.maxQuickPerWeek) : '∞' })}${maxQuickPerWeek !== null ? ' ✏️' : ''}\n` +
      `> ${i18n.t('vacation.config_auto_deny', locale, { hours: String((updated as any).autoDenyHours ?? 8) })}${autoDenyHours !== null ? ' ✏️' : ''}`,
    )],
    ephemeral: true,
  });

  log.info(`Антиабьюз обновлён: cooldown=${updated.cooldownDays}, maxMonth=${updated.maxPerMonth}, maxQuick=${updated.maxQuickPerWeek}, autoDenyH=${(updated as any).autoDenyHours ?? 8}`);
}

// ═══════════════════════════════════════════════
//  /vacation ns_panel — Панель отпуска Небесных Стражей
// ═══════════════════════════════════════════════

async function handleNsPanel(
  interaction: ChatInputCommandInteraction,
  client: BublikClient,
  locale: string,
): Promise<void> {
  const nsGuildId = Config.nsGuildId;
  if (!nsGuildId || interaction.guildId !== nsGuildId) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('vacation.ns_disabled', locale))],
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true) as TextChannel;

  await interaction.deferReply({ ephemeral: true });

  await channel.send({
    embeds: [buildNsPanelEmbed(locale)],
    components: [buildNsPanelButtons(locale)],
  });

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('vacation.ns_panel_deployed', locale))],
  });

  log.info(`НС панель развёрнута в #${channel.name}`);
}

export default vacationCommand;
