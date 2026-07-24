// ═══════════════════════════════════════════════
//  /voice setup — настройка генератора tempvoice
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  GuildMember,
  type GuildBasedChannel,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import {
  evaluateInteractionRole,
  fetchRolePolicySubject,
  hasDangerousAssignablePermissions,
  rolePolicyFailureMessage,
} from '../../../core/RolePolicy';
import {
  createGenerator,
  deleteGenerator,
  getGuildGenerators,
  updateGenerator,
  getGenerator,
  getUserSettings,
  getVoiceLeaderboard,
  getChannel,
  getGeneratorById,
  getGeneratorChannels,
  updateChannel,
} from '../database';
import { getVoiceSession } from '../lifecycle';
import { getAccessLevel, canManage } from '../utils';
import { AccessLevel } from '../constants';
import { buildMainPageEmbed, buildMainPageButtons } from '../embeds';
import { isUnknownChannelError } from '../recovery';
import { runGeneratorExclusive, runGeneratorPermissionMutation } from '../permissionSync';

const log = logger.child('TempVoice:Setup');

const voiceSetup: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Управление временными голосовыми каналами')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Создать генератор временных голосовых каналов')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Голосовой канал-генератор (вход в него создаёт temp-канал)')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName('category')
            .setDescription('Категория для создаваемых каналов')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Шаблон имени ({nickname}, {username}, {game}, {count})')
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName('modrole')
            .setDescription('Роль модераторов (обход ограничений temp-каналов)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Удалить генератор')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал-генератор для удаления')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Список генераторов на сервере'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('addrole')
        .setDescription('Добавить модераторскую роль к генератору')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал-генератор')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Роль для добавления')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('removerole')
        .setDescription('Удалить модераторскую роль из генератора')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал-генератор')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Роль для удаления')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reward')
        .setDescription('Настроить наградную роль для активных пользователей')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Канал-генератор')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Роль-награда (оставить пустым для отключения)')
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('hours')
            .setDescription('Сколько часов в войсе для получения (по умолчанию 50)')
            .setMinValue(1)
            .setMaxValue(10000)
            .setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName('announce')
            .setDescription('Канал для объявлений о наградах')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Статистика голосового времени и прогресс награды'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('top')
        .setDescription('Топ активных пользователей в войсе'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Восстановить панель управления в текстовом чате текущего канала VC'),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.voice.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const locale = await getGuildLocale(interaction.guildId!);

    // Админские команды — требуют ManageChannels
    const adminSubs = new Set(['setup', 'remove', 'list', 'addrole', 'removerole', 'reward']);
    if (adminSubs.has(sub)) {
      const perms = interaction.memberPermissions;
      if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('tempvoice.cmd.admin_only', locale))],
          ephemeral: true,
        });
        return;
      }
    }
    if (sub === 'reward'
      && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
      await interaction.reply({
        embeds: [errorEmbed('Для настройки наградной роли требуется право «Управлять ролями».')],
        ephemeral: true,
      });
      return;
    }

    switch (sub) {
      case 'setup':      await setupGenerator(interaction, locale); break;
      case 'remove':     await removeGenerator(interaction, locale); break;
      case 'list':       await listGenerators(interaction, locale); break;
      case 'addrole':    await addModRole(interaction, locale); break;
      case 'removerole': await removeModRole(interaction, locale); break;
      case 'reward':     await configureReward(interaction, locale); break;
      case 'stats':      await showStats(interaction, locale); break;
      case 'top':        await showTop(interaction, locale); break;
      case 'panel':      await showPanelCommand(interaction, locale, client); break;
    }
  },
};

async function setupGenerator(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const category = interaction.options.getChannel('category', true);
  const nameTemplate = interaction.options.getString('name') ?? '{nickname}';
  const modRole = interaction.options.getRole('modrole');

  if (modRole && (modRole.id === interaction.guildId || modRole.managed)) {
    await interaction.reply({
      embeds: [errorEmbed('Роль @everyone и интеграционные (managed) роли нельзя назначать модераторскими.')],
      ephemeral: true,
    });
    return;
  }

  try {
    await createGenerator({
      guildId: interaction.guildId!,
      channelId: channel.id,
      categoryId: category.id,
      defaultName: nameTemplate,
      immuneRoleIds: modRole ? [modRole.id] : [],
    });

    await interaction.reply({
      embeds: [successEmbed(
        i18n.t('tempvoice.cmd.setup.success', locale, {
          channel: `<#${channel.id}>`,
          categoryName: category.name ?? '',
          nameTemplate,
          modRoleLine: modRole ? `> **Мод-роль:** <@&${modRole.id}>` : '',
        }),
      )],
      ephemeral: true,
    });

    log.info(`Генератор создан: ${channel.id} → ${category.name} (${interaction.guild?.name})`);
  } catch (err: any) {
    if (err.code === 'P2002') {
      await interaction.reply({
        embeds: [errorEmbed(i18n.t('tempvoice.cmd.setup.duplicate', locale))],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }
}

async function removeGenerator(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);

  await interaction.deferReply({ ephemeral: true });

  const generator = await getGenerator(channel.id);
  if (!generator) {
    await interaction.editReply({
      embeds: [errorEmbed('Этот канал не зарегистрирован как генератор временных войсов.')],
    });
    return;
  }

  const failed: string[] = [];
  await runGeneratorExclusive(generator.id, async (assertGeneratorOwned) => {
    const current = await getGeneratorById(generator.id);
    if (!current || current.guildId !== interaction.guildId || current.channelId !== channel.id) return;

    const processed = new Set<string>();
    // Creation holds this same lock. A second snapshot nevertheless protects
    // against rows committed by a worker whose old lease expired at the edge.
    for (let pass = 0; pass < 2; pass++) {
      const activeChannels = await getGeneratorChannels(current.id);
      for (const active of activeChannels) {
        if (processed.has(active.id)) continue;
        processed.add(active.id);
        await assertGeneratorOwned();
        let discordChannel: GuildBasedChannel | null;
        try {
          discordChannel = await interaction.guild!.channels.fetch(active.id, { force: true });
        } catch (error) {
          if (isUnknownChannelError(error)) continue;
          log.warn(`Remove generator: lookup ${active.id} временно недоступен`, { error: String(error) });
          failed.push(active.id);
          continue;
        }
        if (!discordChannel) {
          failed.push(active.id);
          continue;
        }
        try {
          await discordChannel.delete('TempVoice: генератор удалён администратором');
        } catch (error) {
          if (isUnknownChannelError(error)) continue;
          log.warn(`Remove generator: delete ${active.id} не удался`, { error: String(error) });
          failed.push(active.id);
        }
      }
    }

    if (failed.length === 0) {
      await assertGeneratorOwned();
      await deleteGenerator(channel.id);
    }
  });

  if (failed.length > 0) {
    await interaction.editReply({
      embeds: [errorEmbed(`Не удалось удалить временные каналы: ${failed.map((id) => `<#${id}>`).join(', ')}. Генератор сохранён; повторите команду.`)],
    });
    return;
  }

  await interaction.editReply({
    embeds: [successEmbed(i18n.t('tempvoice.cmd.remove.success', locale, { channel: `<#${channel.id}>` }))],
  });

  log.info(`Генератор удалён: ${channel.id} (${interaction.guild?.name})`);
}

async function listGenerators(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const generators = await getGuildGenerators(interaction.guildId!);

  if (generators.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.list.empty', locale))],
      ephemeral: true,
    });
    return;
  }

  const lines = generators.map((g, i) => {
    const roles = g.immuneRoleIds.length > 0
      ? g.immuneRoleIds.map((id) => `<@&${id}>`).join(', ')
      : i18n.t('tempvoice.cmd.list.no_roles', locale);
    return (
      `**${i + 1}.** <#${g.channelId}> → \`${g.defaultName}\`\n` +
      `> ${i18n.t('tempvoice.cmd.list.item_limit', locale, { max: String(g.maxChannelsPerUser), roles })}` +
      (g.boosterPerks ? ` · ${i18n.t('tempvoice.cmd.list.booster_perks', locale)}` : '')
    );
  });

  await interaction.reply({
    embeds: [successEmbed(
      `${i18n.t('tempvoice.cmd.list.header', locale, { count: String(generators.length) })}\n\n${lines.join('\n\n')}`,
    )],
    ephemeral: true,
  });
}

async function addModRole(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role', true);

  if (role.id === interaction.guildId || role.managed) {
    await interaction.reply({
      embeds: [errorEmbed('Роль @everyone и интеграционные (managed) роли нельзя назначать модераторскими.')],
      ephemeral: true,
    });
    return;
  }

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.addrole.not_generator', locale, { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  if (gen.immuneRoleIds.includes(role.id)) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.addrole.already_added', locale, { role: `<@&${role.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  const newRoles = [...gen.immuneRoleIds, role.id];
  await runGeneratorPermissionMutation(
    interaction.client,
    gen.guildId,
    gen.id,
    `immune role added: ${role.id}`,
    () => updateGenerator(channel.id, { immuneRoleIds: newRoles }),
  );

  const rolesList = newRoles.map((id) => `<@&${id}>`).join(', ');
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('tempvoice.cmd.addrole.success', locale, {
        role: `<@&${role.id}>`,
        channel: `<#${channel.id}>`,
        rolesList,
      }),
    )],
    ephemeral: true,
  });

  log.info(`ModRole +${role.name} → генератор ${channel.id}`);
}

async function removeModRole(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role', true);

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.removerole.not_generator', locale, { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  if (!gen.immuneRoleIds.includes(role.id)) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.removerole.not_in_list', locale, { role: `<@&${role.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  const newRoles = gen.immuneRoleIds.filter((id) => id !== role.id);
  await runGeneratorPermissionMutation(
    interaction.client,
    gen.guildId,
    gen.id,
    `immune role removed: ${role.id}`,
    () => updateGenerator(channel.id, { immuneRoleIds: newRoles }),
  );

  const rolesList = newRoles.length > 0
    ? newRoles.map((id) => `<@&${id}>`).join(', ')
    : i18n.t('tempvoice.cmd.list.no_roles', locale);
  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('tempvoice.cmd.removerole.success', locale, {
        role: `<@&${role.id}>`,
        channel: `<#${channel.id}>`,
        rolesList,
      }),
    )],
    ephemeral: true,
  });

  log.info(`ModRole -${role.name} → генератор ${channel.id}`);
}

// ═══════════════════════════════════════════════
//  /voice reward — настройка наградной роли
// ═══════════════════════════════════════════════

async function configureReward(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role');
  const hours = interaction.options.getInteger('hours');
  const announceChannel = interaction.options.getChannel('announce');

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.reward.not_generator', locale, { channel: `<#${channel.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  // Если роль не указана — отключить систему наград
  if (!role) {
    await updateGenerator(channel.id, {
      rewardRoleId: null,
      rewardAnnounceChId: null,
    });
    await interaction.reply({
      embeds: [successEmbed(i18n.t('tempvoice.cmd.reward.off', locale))],
      ephemeral: true,
    });
    log.info(`Reward OFF → генератор ${channel.id}`);
    return;
  }

  const roleDecision = await evaluateInteractionRole(interaction, role.id);
  if (!roleDecision.ok) {
    await interaction.reply({
      embeds: [errorEmbed(rolePolicyFailureMessage(roleDecision.reason))],
      ephemeral: true,
    });
    return;
  }
  const currentRole = await fetchRolePolicySubject(interaction.guild!, role.id);
  if (!currentRole || hasDangerousAssignablePermissions(currentRole.permissions)) {
    await interaction.reply({
      embeds: [errorEmbed('Наградная роль не может содержать административные права.')],
      ephemeral: true,
    });
    return;
  }

  const thresholdMinutes = (hours ?? 50) * 60;

  await updateGenerator(channel.id, {
    rewardRoleId: role.id,
    rewardThresholdMin: thresholdMinutes,
    rewardAnnounceChId: announceChannel?.id ?? gen.rewardAnnounceChId,
  });

  const thresholdHours = thresholdMinutes / 60;
  const announceText = announceChannel
    ? `<#${announceChannel.id}>`
    : (gen.rewardAnnounceChId ? `<#${gen.rewardAnnounceChId}>` : i18n.t('tempvoice.cmd.reward.announce_not_set', locale));

  await interaction.reply({
    embeds: [successEmbed(
      i18n.t('tempvoice.cmd.reward.on', locale, {
        role: `<@&${role.id}>`,
        hours: String(thresholdHours),
        announceChannel: announceText,
      }),
    )],
    ephemeral: true,
  });

  log.info(`Reward: роль ${role.name}, порог ${thresholdHours}ч → генератор ${channel.id}`);
}

// ═══════════════════════════════════════════════
//  /voice stats — статистика пользователя
// ═══════════════════════════════════════════════

async function showStats(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  const settings = await getUserSettings(userId, guildId);
  const totalMinutes = settings?.totalVoiceMinutes ?? 0;
  const rewardGranted = settings?.rewardGranted ?? false;

  // Текущая сессия
  const session = await getVoiceSession(guildId, userId);
  let currentSessionText = '';
  if (session) {
    const sessionMinutes = Math.floor((Date.now() - session.joinedAt) / 60_000);
    currentSessionText = `\n> ${i18n.t('tempvoice.cmd.stats.session', locale, { sessionMinutes: String(sessionMinutes) })}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  // Найти генератор с наградой для прогресс-бара
  const generators = await getGuildGenerators(guildId);
  const rewardGen = generators.find((g) => g.rewardRoleId);

  let progressText = '';
  if (rewardGen) {
    const thresholdHours = rewardGen.rewardThresholdMin / 60;
    if (rewardGranted) {
      progressText = `\n\n${i18n.t('tempvoice.cmd.stats.reward_granted', locale, { role: `<@&${rewardGen.rewardRoleId}>` })}`;
    } else {
      const progress = Math.min(100, Math.floor((totalMinutes / rewardGen.rewardThresholdMin) * 100));
      const barFull = Math.floor(progress / 10);
      const barEmpty = 10 - barFull;
      const bar = '█'.repeat(barFull) + '░'.repeat(barEmpty);
      progressText = `\n\n${i18n.t('tempvoice.cmd.stats.progress_label', locale, { role: `<@&${rewardGen.rewardRoleId}>` })}\n` +
        `> ${i18n.t('tempvoice.cmd.stats.progress_bar', locale, { bar, progress: String(progress), hours: String(hours), thresholdHours: String(thresholdHours) })}`;
    }
  }

  await interaction.reply({
    embeds: [successEmbed(
      `${i18n.t('tempvoice.cmd.stats.title', locale)}\n\n` +
      `> ${i18n.t('tempvoice.cmd.stats.total', locale, { hours: String(hours), mins: String(mins) })}` +
      currentSessionText +
      progressText,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /voice top — лидерборд
// ═══════════════════════════════════════════════

async function showTop(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const guildId = interaction.guildId!;

  const leaders = await getVoiceLeaderboard(guildId, 10);

  if (leaders.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.cmd.top.empty', locale))],
      ephemeral: true,
    });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = leaders.map((l, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const hours = Math.floor(l.totalVoiceMinutes / 60);
    const mins = l.totalVoiceMinutes % 60;
    const rewardIcon = l.rewardGranted ? ' 🏆' : '';
    return `${medal} <@${l.userId}> — **${hours}ч ${mins}мин**${rewardIcon}`;
  });

  await interaction.reply({
    embeds: [successEmbed(
      `${i18n.t('tempvoice.cmd.top.header', locale, { count: String(leaders.length) })}\n\n${lines.join('\n')}`,
    )],
    ephemeral: true,
  });
}

async function showPanelCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  _client: BublikClient,
): Promise<void> {
  const isRu = locale === 'ru';
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.err.not_in_voice', locale))],
      ephemeral: true,
    });
    return;
  }

  const channelData = await getChannel(voiceChannel.id);
  if (!channelData) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.err.not_tempvoice', locale))],
      ephemeral: true,
    });
    return;
  }

  const generator = await getGeneratorById(channelData.generatorId);
  if (!generator) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.err.generator_not_found', locale))],
      ephemeral: true,
    });
    return;
  }

  const accessLevel = await getAccessLevel(member, channelData, generator);
  if (accessLevel === AccessLevel.Blocked) {
    await interaction.reply({
      embeds: [errorEmbed(i18n.t('tempvoice.err.blocked', locale))],
      ephemeral: true,
    });
    return;
  }

  if (!canManage(accessLevel)) {
    await interaction.reply({
      embeds: [errorEmbed(isRu ? 'У вас недостаточно прав для управления этим каналом.' : 'You do not have permission to manage this channel.')],
      ephemeral: true,
    });
    return;
  }

  // Начинаем воссоздание
  await interaction.deferReply({ ephemeral: true });

  // Сначала пробуем удалить старое сообщение панели
  if (channelData.controlMsgId) {
    try {
      const oldMsg = await voiceChannel.messages.fetch(channelData.controlMsgId).catch(() => null);
      if (oldMsg) await oldMsg.delete().catch(() => null);
    } catch { /* ignore */ }
  }

  const owner = await interaction.guild!.members.fetch(channelData.ownerId).catch(() => null);
  const ownerTag = owner?.user.tag ?? i18n.t('tempvoice.err.owner_unknown', locale);

  try {
    const embed = buildMainPageEmbed(
      ownerTag,
      voiceChannel.name,
      channelData.state,
      voiceChannel.members.size,
      voiceChannel.userLimit,
      voiceChannel.bitrate,
      locale,
    );

    const msg = await voiceChannel.send({
      embeds: [embed],
      components: buildMainPageButtons(locale),
    });

    await updateChannel(channelData.id, { controlMsgId: msg.id });

    await interaction.editReply({
      embeds: [successEmbed(isRu ? 'Панель управления успешно воссоздана в чате канала!' : 'Control panel successfully recreated in channel chat!')],
    });
  } catch (err) {
    log.error('Ошибка воссоздания панели в /voice panel', err);
    await interaction.editReply({
      embeds: [errorEmbed(isRu ? 'Не удалось отправить панель в канал.' : 'Failed to send panel to the channel.')],
    });
  }
}

export default voiceSetup;
