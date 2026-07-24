// ═══════════════════════════════════════════════
//  /economy — Админская команда настройки экономики
//
//  Субкоманды:
//  • setup   — каналы (новости, логи)
//  • toggle  — вкл/выкл экономики
//  • config  — текущая конфигурация
//  • reset   — сброс профиля пользователя
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
import { getDatabase } from '../../../core/Database';
import {
  upsertEcoConfig,
  getEcoConfig,
  invalidateProfileCache,
  getOrCreateProfile,
} from '../database';
import { buildSetupEmbed, ecoError, ecoSuccess } from '../embeds';
import { PB_TIERS, EMOJI } from '../constants';
import { fmt } from '../profile';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { syncGuildPbTierRoles, syncPbTierRoles } from '../voice-tracker';
import {
  evaluateRolePolicy,
  fetchRolePolicySubject,
  loadInteractionRolePolicyContext,
  rolePolicyFailureMessage,
  type RolePolicyFailureReason,
} from '../../../core/RolePolicy';
import { hasForbiddenEconomyRewardPermissions } from '../reward-role-policy';
import { replacePbTierRolesWithReconciliationIntent } from '../pb-tier-reconciliation';
import {
  resetEconomyProfileAtomically,
  updatePbVoiceHoursAtomically,
} from '../admin-profile';

const log = logger.child('Economy:Command');

export function hasDuplicateConfiguredRoles(roleIds: readonly string[]): boolean {
  const configured = roleIds.filter(Boolean);
  return new Set(configured).size !== configured.length;
}

export function roleIdsRequiringPolicyValidation(roleIds: readonly string[]): string[] {
  return [...new Set(roleIds.filter(Boolean))];
}

function discordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = Number((error as { code?: unknown }).code);
  return Number.isSafeInteger(code) ? code : null;
}

async function reconcileMemberPbTierAfterAdminChange(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  try {
    const member = guild.members.cache.get(userId)
      ?? await guild.members.fetch({ user: userId, force: true });
    await syncPbTierRoles(member);
  } catch (error) {
    // A departed member has no Discord role state to reconcile. Every other
    // failure remains operational evidence and must not be treated as absence.
    if (discordErrorCode(error) === 10_007) return;
    log.error(`Immediate PB tier reconciliation failed for ${userId} in ${guild.id}`, error);
  }
}

async function reconcileGuildPbTiersAfterConfigChange(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  try {
    const result = await syncGuildPbTierRoles(guild);
    if (result.failed > 0) {
      log.warn(`PB tier configuration reconciliation remains pending in ${guild.id}`, {
        failed: result.failed,
      });
    }
  } catch (error) {
    log.error(`Immediate PB tier configuration reconciliation failed in ${guild.id}`, error);
  }
}

const economyCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('Управление системой экономики')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)

    // ── setup ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Настроить каналы экономики')
        .addChannelOption((opt) =>
          opt
            .setName('news')
            .setDescription('Канал новостей экономики')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('log')
            .setDescription('Канал логов экономики (для админов)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('leaderboard')
            .setDescription('Канал авто-лидерборда (обновляется каждый час)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('market')
            .setDescription('Канал модерации маркетплейса (заявки /market submit)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('welcomebonus')
            .setDescription('Стартовый капитал для новичков (0 = отключить)')
            .setMinValue(0)
            .setMaxValue(100000)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('police')
            .setDescription('Роль полиции для /capture')
            .setRequired(false)
        )
        .addRoleOption((opt) =>
          opt
            .setName('staff')
            .setDescription('Роль сотрудников мэрии для /government')
            .setRequired(false)
        ),
    )

    // ── toggle ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Включить/выключить экономику'),
    )

    // ── config ────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('config')
        .setDescription('Показать текущую конфигурацию экономики'),
    )

    // ── reset ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Сбросить профиль экономики пользователя')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Пользователь для сброса')
            .setRequired(true),
        ),
    )

    // ── roles ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('roles')
        .setDescription('Настроить PB-роли (до 10 тиров, от низшего к высшему)')
        .addRoleOption((o) => o.setName('tier1').setDescription('Тир 1: Шалом, полковые! (50ч, x1.0)').setRequired(false))
        .addRoleOption((o) => o.setName('tier2').setDescription('Тир 2: Кошерный Воин (100ч, x1.1)').setRequired(false))
        .addRoleOption((o) => o.setName('tier3').setDescription('Тир 3: Моше Даян Войса (200ч, x1.2)').setRequired(false))
        .addRoleOption((o) => o.setName('tier4').setDescription('Тир 4: Маца и Меркава (400ч, x1.3)').setRequired(false))
        .addRoleOption((o) => o.setName('tier5').setDescription('Тир 5: Шаббатний Ветеран (600ч, x1.4)').setRequired(false))
        .addRoleOption((o) => o.setName('tier6').setDescription('Тир 6: 800ч').setRequired(false))
        .addRoleOption((o) => o.setName('tier7').setDescription('Тир 7: 1200ч').setRequired(false))
        .addRoleOption((o) => o.setName('tier8').setDescription('Тир 8: 2000ч').setRequired(false))
        .addRoleOption((o) => o.setName('tier9').setDescription('Тир 9: 3500ч').setRequired(false))
        .addRoleOption((o) => o.setName('tier10').setDescription('Тир 10: 5000ч').setRequired(false)),
    )

    // ── voicehours ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('voicehours')
        .setDescription('PB-voice часы: посмотреть / изменить / восстановить из истории')
        .addUserOption((o) =>
          o
            .setName('user')
            .setDescription('Пользователь')
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('set_hours')
            .setDescription('Установить часы (перезапись)')
            .setMinValue(0)
            .setRequired(false),
        )
        .addIntegerOption((o) =>
          o
            .setName('add_hours')
            .setDescription('Добавить часы к текущим')
            .setMinValue(1)
            .setRequired(false),
        )
        .addBooleanOption((o) =>
          o
            .setName('restore_from_tx')
            .setDescription('Восстановить по транзакциям earn_voice (1 tx = 10 минут)')
            .setRequired(false),
        ),
    )

    // ── market ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('market')
        .setDescription('Параметры маркетплейса ролей (без аргументов = показать текущие)')
        .addBooleanOption((o) =>
          o.setName('enabled').setDescription('Включить/выключить маркетплейс').setRequired(false),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Канал модерации заявок').addChannelTypes(ChannelType.GuildText).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('fee').setDescription('Взнос за заявку (₪, возврат при отказе)').setMinValue(0).setMaxValue(1_000_000).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('commission').setDescription('Комиссия продавцу с продажи (%, 0..100)').setMinValue(0).setMaxValue(100).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('maxperuser').setDescription('Макс. активных + pending ролей у одного продавца').setMinValue(1).setMaxValue(50).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('minprice').setDescription('Минимальная цена роли (₪)').setMinValue(1).setMaxValue(10_000_000).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('maxprice').setDescription('Максимальная цена роли (₪)').setMinValue(1).setMaxValue(100_000_000).setRequired(false),
        ),
    )

    // ── pbchannels ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('pbchannels')
        .setDescription('Настроить ПБ-каналы/категории для начисления тир-ролей (в /economy roles)')
        .addChannelOption((o) =>
          o
            .setName('add')
            .setDescription('Добавить канал как ПБ-войс')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('remove')
            .setDescription('Убрать канал из ПБ-войсов')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('add_category')
            .setDescription('Добавить категорию (все её войсы считать ПБ)')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('remove_category')
            .setDescription('Убрать категорию из ПБ')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addBooleanOption((o) =>
          o
            .setName('show')
            .setDescription('Показать текущие ПБ-каналы и категории')
            .setRequired(false),
        ),
    )

    // ── event ─────────────────────
    .addSubcommand((sub) =>
      sub
        .setName('event')
        .setDescription('Сезонный эвент / weekend-бустер (без аргументов = текущее состояние)')
        .addStringOption((o) =>
          o.setName('name').setDescription('Название эвента (пример: «Пурим»). Пустое = оставить.').setMaxLength(50).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('duration_hours').setDescription('Длительность эвента, часы (1..720)').setMinValue(1).setMaxValue(720).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('earn_mul').setDescription('Множитель заработка, % (50..500, 100=x1.0)').setMinValue(50).setMaxValue(500).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('rob_mul').setDescription('Множитель добычи от грабежа, % (50..500)').setMinValue(50).setMaxValue(500).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('wanted_mul').setDescription('Множитель wanted-звёзд, % (0..500)').setMinValue(0).setMaxValue(500).setRequired(false),
        )
        .addBooleanOption((o) =>
          o.setName('weekend').setDescription('Авто-буст в субботу/воскресенье').setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('weekend_earn_mul').setDescription('Weekend × earn, % (50..500)').setMinValue(50).setMaxValue(500).setRequired(false),
        )
        .addIntegerOption((o) =>
          o.setName('weekend_rob_mul').setDescription('Weekend × rob, % (50..500)').setMinValue(50).setMaxValue(500).setRequired(false),
        )
        .addBooleanOption((o) =>
          o.setName('clear').setDescription('Сбросить текущий эвент (оставит weekend-настройки)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('treasury')
        .setDescription('Управление казной г. Неве-Эрез')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Действие')
            .setRequired(true)
            .addChoices(
              { name: 'Показать баланс', value: 'show' },
              { name: 'Добавить шекели', value: 'add' },
              { name: 'Изъять шекели', value: 'remove' },
              { name: 'Установить баланс', value: 'set' },
            ),
        )
        .addIntegerOption((o) =>
          o
            .setName('amount')
            .setDescription('Сумма шекелей')
            .setMinValue(1)
            .setRequired(false),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.economy.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        embeds: [ecoError('⛔ Эта команда доступна только администраторам сервера.')],
        ephemeral: true,
      });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);

    switch (sub) {
      case 'setup':
        await handleSetup(interaction, guildId, locale);
        break;
      case 'toggle':
        await handleToggle(interaction, guildId, locale);
        break;
      case 'config':
        await handleConfig(interaction, guildId, locale);
        break;
      case 'reset':
        await handleReset(interaction, guildId, locale);
        break;
      case 'roles':
        await handleRoles(interaction, guildId, locale);
        break;
      case 'voicehours':
        await handleVoiceHours(interaction, guildId, locale);
        break;
      case 'market':
        await handleMarketConfig(interaction, guildId, locale);
        break;
      case 'pbchannels':
        await handlePbChannels(interaction, guildId, locale);
        break;
      case 'event':
        await handleEventConfig(interaction, guildId, locale);
        break;
      case 'treasury':
        await handleTreasury(interaction, guildId, locale);
        break;
      default:
        await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.economy.error_unknown_sub', locale))], ephemeral: true });
    }
  },
};

// ── setup ─────────────────────────────────────

async function handleSetup(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const newsChannel = interaction.options.getChannel('news');
  const logChannel = interaction.options.getChannel('log');
  const leaderboardChannel = interaction.options.getChannel('leaderboard');
  const marketChannel = interaction.options.getChannel('market');
  const welcomeBonus = interaction.options.getInteger('welcomebonus');
  const policeRole = interaction.options.getRole('police');
  const staffRole = interaction.options.getRole('staff');

  if (!newsChannel && !logChannel && !leaderboardChannel && !marketChannel && welcomeBonus === null && !policeRole && !staffRole) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.economy.setup_error_no_channel', locale))],
      ephemeral: true,
    });
    return;
  }

  for (const selectedRole of [policeRole, staffRole].filter((role) => role !== null)) {
    const freshRole = await fetchRolePolicySubject(interaction.guild!, selectedRole.id).catch(() => null);
    let failure: RolePolicyFailureReason | null = null;
    if (!freshRole) failure = 'role_missing';
    else if (freshRole.id === guildId) failure = 'everyone';
    else if (freshRole.managed) failure = 'managed';
    if (failure) {
      await interaction.reply({ embeds: [ecoError(rolePolicyFailureMessage(failure))], ephemeral: true });
      return;
    }
  }

  const data: Record<string, any> = {};
  if (newsChannel) data.newsChannelId = newsChannel.id;
  if (logChannel) data.logChannelId = logChannel.id;
  if (leaderboardChannel) {
    data.leaderboardChannelId = leaderboardChannel.id;
    data.leaderboardMessageId = null; // Сброс — будет создано новое
  }
  if (marketChannel) data.marketModChannelId = marketChannel.id;
  if (welcomeBonus !== null) data.welcomeBonus = welcomeBonus;
  if (policeRole) data.policeRoleId = policeRole.id;
  if (staffRole) data.govStaffRoleId = staffRole.id;

  await upsertEcoConfig(guildId, data);

  const config = await getEcoConfig(guildId);

  await interaction.reply({
    embeds: [
      buildSetupEmbed(
        interaction.guild!.name,
        config?.enabled ?? true,
        config?.newsChannelId ?? null,
        config?.logChannelId ?? null,
        config?.leaderboardChannelId ?? null,
        config?.welcomeBonus ?? 0,
        config?.policeRoleId ?? null,
        config?.govStaffRoleId ?? null,
        locale,
      ),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] Экономика настроена: news=${newsChannel?.id}, log=${logChannel?.id}, leaderboard=${leaderboardChannel?.id}, welcomeBonus=${welcomeBonus}, police=${policeRole?.id}, staff=${staffRole?.id}`);
}

// ── toggle ────────────────────────────────────

async function handleToggle(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const config = await getEcoConfig(guildId);
  const currentState = config?.enabled ?? true;
  const newState = !currentState;

  await upsertEcoConfig(guildId, { enabled: newState });

  await interaction.reply({
    embeds: [
      ecoSuccess(
        newState
          ? i18n.t('economy.cmd.economy.toggle_enabled', locale)
          : i18n.t('economy.cmd.economy.toggle_disabled', locale),
      ),
    ],
    ephemeral: true,
  });

  log.info(`[${guildId}] Экономика ${newState ? 'включена' : 'выключена'}`);
}

// ── config ────────────────────────────────────

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const config = await getEcoConfig(guildId);

  if (!config) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.economy.config_not_found', locale))],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [
      buildSetupEmbed(
        interaction.guild!.name,
        config.enabled,
        config.newsChannelId,
        config.logChannelId,
        config.leaderboardChannelId,
        config.welcomeBonus,
        config.policeRoleId,
        config.govStaffRoleId,
        locale,
      ),
    ],
    ephemeral: true,
  });
}

// ── reset ─────────────────────────────────────

async function handleReset(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const target = interaction.options.getUser('user', true);

  try {
    await resetEconomyProfileAtomically(guildId, target.id);

    await interaction.reply({
      embeds: [ecoSuccess(i18n.t('economy.cmd.economy.reset_success', locale, { userId: target.id }))],
      ephemeral: true,
    });
    await reconcileMemberPbTierAfterAdminChange(interaction, target.id);

    log.info(`[${guildId}] Профиль ${target.id} сброшен администратором ${interaction.user.id}`);
  } catch (err) {
    log.error(`Ошибка сброса профиля ${target.id}`, err);
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.cmd.economy.reset_error', locale))],
      ephemeral: true,
    });
  }
}

// ── roles ───────────────────────────────────────

async function handleRoles(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  // Собираем роли из опций (tier1..tier10)
  const config = await getEcoConfig(guildId);
  const existing: string[] = config?.pbRoleIds ?? [];

  const roleIds: string[] = [...existing];
  // Заполняем до 10 элементов
  while (roleIds.length < 10) roleIds.push('');

  let updated = false;
  for (let i = 0; i < 10; i++) {
    const role = interaction.options.getRole(`tier${i + 1}`);
    if (role) {
      roleIds[i] = role.id;
      updated = true;
    }
  }

  if (!updated) {
    // Показываем текущие настройки
    const lines = PB_TIERS.map((t, i) => {
      const rId = existing[i];
      const roleStr = rId ? `<@&${rId}>` : i18n.t('economy.cmd.economy.roles_not_set', locale);
      return `**${i + 1}.** ${i18n.t(t.nameKey, locale)} (${t.hours}ч, x${t.multiplier}, банк: ${t.bankLimit === Infinity ? '∞' : t.bankLimit.toLocaleString('ru-RU')}) — ${roleStr}`;
    });

    await interaction.reply({
      embeds: [
        ecoSuccess(
          `**${i18n.t('economy.cmd.economy.roles_title', locale)}**\n\n${lines.join('\n')}\n\n` +
          i18n.t('economy.cmd.economy.roles_hint', locale),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  // Сохраняем обновлённый массив (убираем trailing empty)
  const trimmed = roleIds.slice();
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1]) trimmed.pop();

  if (hasDuplicateConfiguredRoles(trimmed)) {
    await interaction.reply({
      embeds: [ecoError('Одну и ту же роль нельзя назначить на несколько PB-тиров.')],
      ephemeral: true,
    });
    return;
  }

  const policyContext = await loadInteractionRolePolicyContext(interaction).catch(() => null);
  if (!policyContext) {
    await interaction.reply({ embeds: [ecoError(rolePolicyFailureMessage('wrong_guild'))], ephemeral: true });
    return;
  }
  // Revalidate the complete final configuration. A retained role may have
  // gained dangerous permissions or moved in the hierarchy since setup.
  const uniqueSelectedRoleIds = roleIdsRequiringPolicyValidation(trimmed);
  const freshSelectedRoles = await Promise.all(
    uniqueSelectedRoleIds.map((roleId) => fetchRolePolicySubject(interaction.guild!, roleId).catch(() => null)),
  );
  for (const freshRole of freshSelectedRoles) {
    const decision = evaluateRolePolicy(policyContext, freshRole);
    if (!decision.ok) {
      await interaction.reply({ embeds: [ecoError(rolePolicyFailureMessage(decision.reason))], ephemeral: true });
      return;
    }
    if (freshRole && hasForbiddenEconomyRewardPermissions(freshRole.permissions)) {
      await interaction.reply({
        embeds: [ecoError('PB-награда не может выдавать роль с административными или модераторскими правами.')],
        ephemeral: true,
      });
      return;
    }
  }

  await replacePbTierRolesWithReconciliationIntent(guildId, trimmed);

  const lines = PB_TIERS.slice(0, Math.max(trimmed.length, 10)).map((t, i) => {
    const rId = trimmed[i];
    const roleStr = rId ? `<@&${rId}>` : i18n.t('economy.cmd.economy.roles_not_set', locale);
    return `**${i + 1}.** ${i18n.t(t.nameKey, locale)} — ${roleStr}`;
  });

  await interaction.reply({
    embeds: [
      ecoSuccess(`**${i18n.t('economy.cmd.economy.roles_updated', locale)}**\n\n${lines.join('\n')}`),
    ],
    ephemeral: true,
  });
  await reconcileGuildPbTiersAfterConfigChange(interaction);

  log.info(`[${guildId}] PB-роли обновлены: [${trimmed.join(', ')}]`);
}

async function handleVoiceHours(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  _locale: string,
): Promise<void> {
  const target = interaction.options.getUser('user', true);
  const setHours = interaction.options.getInteger('set_hours');
  const addHours = interaction.options.getInteger('add_hours');
  const restoreFromTx = interaction.options.getBoolean('restore_from_tx') ?? false;

  const pbHoursChanged = restoreFromTx || setHours !== null || addHours !== null;
  const seconds = pbHoursChanged
    ? await updatePbVoiceHoursAtomically(guildId, target.id, {
      restoreFromTransactions: restoreFromTx,
      setHours,
      addHours,
    })
    : Number((await getOrCreateProfile(guildId, target.id)).pbVoiceSeconds ?? 0);

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  await interaction.reply({
    embeds: [
      ecoSuccess(
        `**PB-voice часы для <@${target.id}>**\n\n` +
        `Текущее значение: **${hours}ч ${mins}м**\n` +
        (restoreFromTx ? `Восстановлено из транзакций: ✅\n` : '') +
        (setHours !== null ? `Установлено вручную: **${setHours}ч**\n` : '') +
        (addHours !== null ? `Добавлено вручную: **+${addHours}ч**\n` : ''),
      ),
    ],
    ephemeral: true,
  });
  if (pbHoursChanged) await reconcileMemberPbTierAfterAdminChange(interaction, target.id);
}

// ── pbchannels ────────────────────────────────

async function handlePbChannels(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const addChannel = interaction.options.getChannel('add');
  const removeChannel = interaction.options.getChannel('remove');
  const addCategory = interaction.options.getChannel('add_category');
  const removeCategory = interaction.options.getChannel('remove_category');
  const show = interaction.options.getBoolean('show');

  const config = await getEcoConfig(guildId);
  const currentIds: string[] = config?.pbVoiceChannelIds ?? [];
  const currentCategoryIds: string[] = config?.pbVoiceCategoryIds ?? [];

  if (show || (!addChannel && !removeChannel && !addCategory && !removeCategory)) {
    const channelLines = await Promise.all(
      currentIds.map(async (id) => {
        const ch = await interaction.guild?.channels.fetch(id).catch(() => null);
        return ch ? `#${ch.name} (\`${id}\`)` : `\`${id}\``;
      }),
    );
    const categoryLines = await Promise.all(
      currentCategoryIds.map(async (id) => {
        const ch = await interaction.guild?.channels.fetch(id).catch(() => null);
        return ch ? `${ch.name} (\`${id}\`)` : `\`${id}\``;
      }),
    );

    const channelsText = channelLines.length > 0
      ? channelLines.join('\n')
      : i18n.t('economy.cmd.economy.pbchannels_none', locale);
    const categoriesText = categoryLines.length > 0
      ? categoryLines.join('\n')
      : i18n.t('economy.cmd.economy.pbchannels_none', locale);

    await interaction.reply({
      embeds: [
        ecoSuccess(
          `**${i18n.t('economy.cmd.economy.pbchannels_title', locale)}**\n\n` +
          `${i18n.t('economy.cmd.economy.pbchannels_section_channels', locale)}:\n${channelsText}\n\n` +
          `${i18n.t('economy.cmd.economy.pbchannels_section_categories', locale)}:\n${categoriesText}` +
          `\n\n${i18n.t('economy.cmd.economy.pbchannels_hint', locale)}`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  let newIds = [...currentIds];
  let newCategoryIds = [...currentCategoryIds];

  if (addChannel) {
    if (newIds.includes(addChannel.id)) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.economy.pbchannels_exists', locale))],
        ephemeral: true,
      });
      return;
    }
    newIds.push(addChannel.id);
  }

  if (removeChannel) {
    newIds = newIds.filter((id) => id !== removeChannel.id);
  }

  if (addCategory) {
    if (newCategoryIds.includes(addCategory.id)) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.economy.pbchannels_exists', locale))],
        ephemeral: true,
      });
      return;
    }
    newCategoryIds.push(addCategory.id);
  }

  if (removeCategory) {
    newCategoryIds = newCategoryIds.filter((id) => id !== removeCategory.id);
  }

  await upsertEcoConfig(guildId, {
    pbVoiceChannelIds: newIds,
    pbVoiceCategoryIds: newCategoryIds,
  });

  await interaction.reply({
    embeds: [
      ecoSuccess(
        `**${i18n.t('economy.cmd.economy.pbchannels_title', locale)}**\n\n` +
        i18n.t('economy.cmd.economy.pbchannels_updated', locale) +
        `\n\n${i18n.t('economy.cmd.economy.pbchannels_section_channels', locale)}:\n${newIds.map((id) => `<#${id}>`).join('\n') || i18n.t('economy.cmd.economy.pbchannels_none', locale)}` +
        `\n\n${i18n.t('economy.cmd.economy.pbchannels_section_categories', locale)}:\n${newCategoryIds.map((id) => `<#${id}>`).join('\n') || i18n.t('economy.cmd.economy.pbchannels_none', locale)}`,
      ),
    ],
    ephemeral: true,
  });
}

// ── market ────────────────────────────────────

async function handleMarketConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const enabled = interaction.options.getBoolean('enabled');
  const channel = interaction.options.getChannel('channel');
  const fee = interaction.options.getInteger('fee');
  const commission = interaction.options.getInteger('commission');
  const maxPerUser = interaction.options.getInteger('maxperuser');
  const minPrice = interaction.options.getInteger('minprice');
  const maxPrice = interaction.options.getInteger('maxprice');

  // Если переданы и min, и max — проверяем согласованность
  const data: Record<string, any> = {};
  if (enabled !== null) data.marketEnabled = enabled;
  if (channel) data.marketModChannelId = channel.id;
  if (fee !== null) data.marketSubmitFee = fee;
  if (commission !== null) data.marketCommissionPct = commission;
  if (maxPerUser !== null) data.marketMaxPerUser = maxPerUser;
  if (minPrice !== null) data.marketMinPrice = minPrice;
  if (maxPrice !== null) data.marketMaxPrice = maxPrice;

  // Проверка min < max (с учётом текущих значений из БД)
  if (minPrice !== null || maxPrice !== null) {
    const cur = await getEcoConfig(guildId);
    const finalMin = minPrice ?? cur?.marketMinPrice ?? 1000;
    const finalMax = maxPrice ?? cur?.marketMaxPrice ?? 500_000;
    if (finalMin >= finalMax) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.economy.market_error_price_range', locale))],
        ephemeral: true,
      });
      return;
    }
  }

  if (Object.keys(data).length > 0) {
    await upsertEcoConfig(guildId, data);
    log.info(`[${guildId}] Маркет настроен: ${JSON.stringify(data)}`);
  }

  // Показываем итоговую конфигурацию
  const config = await getEcoConfig(guildId);
  const notCfg = i18n.t('economy.setup_not_configured', locale);
  const onLabel = i18n.t('common.enabled', locale);
  const offLabel = i18n.t('common.disabled', locale);

  const lines = [
    `**${i18n.t('economy.cmd.economy.market_status', locale)}**: ${(config?.marketEnabled ?? true) ? `🟢 ${onLabel}` : `🔴 ${offLabel}`}`,
    `**${i18n.t('economy.cmd.economy.market_channel', locale)}**: ${config?.marketModChannelId ? `<#${config.marketModChannelId}>` : notCfg}`,
    `**${i18n.t('economy.cmd.economy.market_fee', locale)}**: ${EMOJI.SHEKEL} ${fmt(config?.marketSubmitFee ?? 5000)}`,
    `**${i18n.t('economy.cmd.economy.market_commission', locale)}**: ${config?.marketCommissionPct ?? 80}%`,
    `**${i18n.t('economy.cmd.economy.market_max_per_user', locale)}**: ${config?.marketMaxPerUser ?? 3}`,
    `**${i18n.t('economy.cmd.economy.market_price_range', locale)}**: ${EMOJI.SHEKEL} ${fmt(config?.marketMinPrice ?? 1000)} – ${fmt(config?.marketMaxPrice ?? 500_000)}`,
  ];

  const action = Object.keys(data).length > 0
    ? i18n.t('economy.cmd.economy.market_updated', locale)
    : i18n.t('economy.cmd.economy.market_current', locale);

  await interaction.reply({
    embeds: [
      ecoSuccess(`**${action}**\n\n${lines.join('\n')}`),
    ],
    ephemeral: true,
  });
}

// ── event ──────────────────────────────

async function handleEventConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<void> {
  const name = interaction.options.getString('name');
  const durationHours = interaction.options.getInteger('duration_hours');
  const earnMul = interaction.options.getInteger('earn_mul');
  const robMul = interaction.options.getInteger('rob_mul');
  const wantedMul = interaction.options.getInteger('wanted_mul');
  const weekend = interaction.options.getBoolean('weekend');
  const weekendEarnMul = interaction.options.getInteger('weekend_earn_mul');
  const weekendRobMul = interaction.options.getInteger('weekend_rob_mul');
  const clear = interaction.options.getBoolean('clear');

  const data: Record<string, any> = {};

  if (clear) {
    data.eventName = '';
    data.eventEndsAt = null;
    data.eventEarnMul = 100;
    data.eventRobMul = 100;
    data.eventWantedMul = 100;
  } else {
    if (name !== null) data.eventName = name;
    if (earnMul !== null) data.eventEarnMul = earnMul;
    if (robMul !== null) data.eventRobMul = robMul;
    if (wantedMul !== null) data.eventWantedMul = wantedMul;
    if (durationHours !== null) {
      data.eventEndsAt = new Date(Date.now() + durationHours * 3_600_000);
    }
  }

  if (weekend !== null) data.eventWeekendEnabled = weekend;
  if (weekendEarnMul !== null) data.eventWeekendEarnMul = weekendEarnMul;
  if (weekendRobMul !== null) data.eventWeekendRobMul = weekendRobMul;

  if (Object.keys(data).length > 0) {
    await upsertEcoConfig(guildId, data);
    log.info(`[${guildId}] Эвент обновлён: ${JSON.stringify(data)}`);
  }

  const config = await getEcoConfig(guildId);
  const onLabel = i18n.t('common.enabled', locale);
  const offLabel = i18n.t('common.disabled', locale);
  const notCfg = i18n.t('economy.setup_not_configured', locale);

  const eventActive = !!(config?.eventName && config?.eventEndsAt && new Date(config.eventEndsAt).getTime() > Date.now());
  const endsAtTs = config?.eventEndsAt ? Math.floor(new Date(config.eventEndsAt).getTime() / 1000) : null;

  const lines = [
    `**${i18n.t('economy.cmd.economy.event_status', locale)}**: ${eventActive ? `🟢 ${onLabel}` : `🔴 ${offLabel}`}`,
    `**${i18n.t('economy.cmd.economy.event_name', locale)}**: ${config?.eventName ? config.eventName : notCfg}`,
    `**${i18n.t('economy.cmd.economy.event_ends_at', locale)}**: ${endsAtTs ? `<t:${endsAtTs}:R>` : notCfg}`,
    `**${i18n.t('economy.cmd.economy.event_muls', locale)}**: earn x${((config?.eventEarnMul ?? 100) / 100).toFixed(2)} · rob x${((config?.eventRobMul ?? 100) / 100).toFixed(2)} · wanted x${((config?.eventWantedMul ?? 100) / 100).toFixed(2)}`,
    `**${i18n.t('economy.cmd.economy.event_weekend', locale)}**: ${(config?.eventWeekendEnabled ?? false) ? `🟢 ${onLabel}` : `🔴 ${offLabel}`} — earn x${((config?.eventWeekendEarnMul ?? 150) / 100).toFixed(2)} · rob x${((config?.eventWeekendRobMul ?? 150) / 100).toFixed(2)}`,
  ];

  const action = Object.keys(data).length > 0
    ? (clear ? i18n.t('economy.cmd.economy.event_cleared', locale) : i18n.t('economy.cmd.economy.event_set', locale))
    : i18n.t('economy.cmd.economy.event_current', locale);

  await interaction.reply({
    embeds: [ecoSuccess(`**${action}**\n\n${lines.join('\n')}`)],
    ephemeral: true,
  });
}

async function handleTreasury(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  _locale: string,
): Promise<void> {
  const action = interaction.options.getString('action', true);
  const amount = interaction.options.getInteger('amount');

  if (action !== 'show' && (amount === null || amount <= 0)) {
    await interaction.reply({
      embeds: [ecoError('❌ Для проведения операции с казной необходимо указать положительную сумму!')],
      ephemeral: true,
    });
    return;
  }

  const db = getDatabase();
  const govProfile = await getOrCreateProfile(guildId, 'government');

  switch (action) {
    case 'show': {
      await interaction.reply({
        embeds: [
          ecoSuccess(
            `🏛️ **Казна города Неве-Эрез**\n\n` +
            `• **Текущий баланс:** **${fmt(govProfile.wallet)} ₪**\n` +
            `• **Накопления в банке:** **${fmt(govProfile.bank)} ₪**`
          ),
        ],
        ephemeral: true,
      });
      break;
    }
    case 'add': {
      const updated = await db.economyProfile.update({
        where: { id: govProfile.id },
        data: { wallet: { increment: amount! } },
      });
      await db.economyTransaction.create({
        data: {
          guildId,
          userId: 'government',
          type: 'treasury_admin_add',
          amount: amount!,
          balance: updated.wallet,
          profileId: govProfile.id,
          details: `Администратор ${interaction.user.id} напечатал шекели в казну`,
        },
      });
      await invalidateProfileCache(guildId, 'government');
      await interaction.reply({
        embeds: [
          ecoSuccess(
            `🏛️ **Казна города Неве-Эрез**\n\n` +
            `💵 В казну успешно добавлено **${fmt(amount!)} ₪**.\n` +
            `• **Новый баланс:** **${fmt(updated.wallet)} ₪**`
          ),
        ],
        ephemeral: true,
      });
      break;
    }
    case 'remove': {
      if (govProfile.wallet < amount!) {
        await interaction.reply({
          embeds: [
            ecoError(
              `❌ В казне недостаточно средств!\n` +
              `• **Доступно:** **${fmt(govProfile.wallet)} ₪**\n` +
              `• **Запрошено к изъятию:** **${fmt(amount!)} ₪**`
            ),
          ],
          ephemeral: true,
        });
        return;
      }
      const updated = await db.economyProfile.update({
        where: { id: govProfile.id },
        data: { wallet: { decrement: amount! } },
      });
      await db.economyTransaction.create({
        data: {
          guildId,
          userId: 'government',
          type: 'treasury_admin_remove',
          amount: -amount!,
          balance: updated.wallet,
          profileId: govProfile.id,
          details: `Администратор ${interaction.user.id} изъял шекели из казны`,
        },
      });
      await invalidateProfileCache(guildId, 'government');
      await interaction.reply({
        embeds: [
          ecoSuccess(
            `🏛️ **Казна города Неве-Эрез**\n\n` +
            `💸 Из казны успешно изъято **${fmt(amount!)} ₪**.\n` +
            `• **Новый баланс:** **${fmt(updated.wallet)} ₪**`
          ),
        ],
        ephemeral: true,
      });
      break;
    }
    case 'set': {
      const updated = await db.economyProfile.update({
        where: { id: govProfile.id },
        data: { wallet: amount! },
      });
      await db.economyTransaction.create({
        data: {
          guildId,
          userId: 'government',
          type: 'treasury_admin_set',
          amount: amount! - govProfile.wallet,
          balance: updated.wallet,
          profileId: govProfile.id,
          details: `Администратор ${interaction.user.id} установил баланс казны в ${amount!}`,
        },
      });
      await invalidateProfileCache(guildId, 'government');
      await interaction.reply({
        embeds: [
          ecoSuccess(
            `🏛️ **Казна города Неве-Эрез**\n\n` +
            `⚙️ Баланс казны успешно установлен в **${fmt(amount!)} ₪**.`
          ),
        ],
        ephemeral: true,
      });
      break;
    }
  }
}

export default economyCommand;
