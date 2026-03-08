// ═══════════════════════════════════════════════
//  /voice setup — настройка генератора tempvoice
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { createGenerator, deleteGenerator, getGuildGenerators, updateGenerator, getGenerator, getUserSettings, getVoiceLeaderboard } from '../database';
import { getVoiceSession } from '../lifecycle';

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
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.voice.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();

    // Админские команды — требуют ManageChannels
    const adminSubs = new Set(['setup', 'remove', 'list', 'addrole', 'removerole', 'reward']);
    if (adminSubs.has(sub)) {
      const perms = interaction.memberPermissions;
      if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) {
        await interaction.reply({
          embeds: [errorEmbed('Эта команда доступна только администраторам.')],
          ephemeral: true,
        });
        return;
      }
    }

    switch (sub) {
      case 'setup':      await setupGenerator(interaction); break;
      case 'remove':     await removeGenerator(interaction); break;
      case 'list':       await listGenerators(interaction); break;
      case 'addrole':    await addModRole(interaction); break;
      case 'removerole': await removeModRole(interaction); break;
      case 'reward':     await configureReward(interaction); break;
      case 'stats':      await showStats(interaction); break;
      case 'top':        await showTop(interaction); break;
    }
  },
};

async function setupGenerator(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const category = interaction.options.getChannel('category', true);
  const nameTemplate = interaction.options.getString('name') ?? '{nickname}';
  const modRole = interaction.options.getRole('modrole');

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
        `🎙️ Генератор настроен!\n\n` +
        `> **Канал:** <#${channel.id}>\n` +
        `> **Категория:** ${category.name}\n` +
        `> **Шаблон имени:** \`${nameTemplate}\`\n` +
        (modRole ? `> **Мод-роль:** <@&${modRole.id}>` : '') +
        `\n\n💡 Добавить ещё мод-роли: \`/voice addrole\``,
      )],
      ephemeral: true,
    });

    log.info(`Генератор создан: ${channel.id} → ${category.name} (${interaction.guild?.name})`);
  } catch (err: any) {
    if (err.code === 'P2002') {
      await interaction.reply({
        embeds: [errorEmbed('Этот канал уже является генератором.')],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }
}

async function removeGenerator(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);

  await deleteGenerator(channel.id);

  await interaction.reply({
    embeds: [successEmbed(`🗑️ Генератор <#${channel.id}> удалён.`)],
    ephemeral: true,
  });

  log.info(`Генератор удалён: ${channel.id} (${interaction.guild?.name})`);
}

async function listGenerators(interaction: ChatInputCommandInteraction): Promise<void> {
  const generators = await getGuildGenerators(interaction.guildId!);

  if (generators.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed('На сервере нет генераторов. Используйте `/voice setup`.')],
      ephemeral: true,
    });
    return;
  }

  const lines = generators.map((g, i) => {
    const roles = g.immuneRoleIds.length > 0
      ? g.immuneRoleIds.map((id) => `<@&${id}>`).join(', ')
      : 'нет';
    return (
      `**${i + 1}.** <#${g.channelId}> → \`${g.defaultName}\`\n` +
      `> Лимит: ${g.maxChannelsPerUser}/чел · Мод-роли: ${roles}` +
      (g.boosterPerks ? ' · 🚀 Бустер-перки' : '')
    );
  });

  await interaction.reply({
    embeds: [successEmbed(
      `🎙️ **Генераторы** (${generators.length}):\n\n${lines.join('\n\n')}`,
    )],
    ephemeral: true,
  });
}

async function addModRole(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role', true);

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(`<#${channel.id}> не является генератором.`)],
      ephemeral: true,
    });
    return;
  }

  if (gen.immuneRoleIds.includes(role.id)) {
    await interaction.reply({
      embeds: [errorEmbed(`<@&${role.id}> уже в списке мод-ролей.`)],
      ephemeral: true,
    });
    return;
  }

  const newRoles = [...gen.immuneRoleIds, role.id];
  await updateGenerator(channel.id, { immuneRoleIds: newRoles });

  const rolesList = newRoles.map((id) => `<@&${id}>`).join(', ');
  await interaction.reply({
    embeds: [successEmbed(
      `✅ <@&${role.id}> добавлена как мод-роль для <#${channel.id}>.\n\n` +
      `> **Текущие мод-роли:** ${rolesList}`,
    )],
    ephemeral: true,
  });

  log.info(`ModRole +${role.name} → генератор ${channel.id}`);
}

async function removeModRole(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role', true);

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(`<#${channel.id}> не является генератором.`)],
      ephemeral: true,
    });
    return;
  }

  if (!gen.immuneRoleIds.includes(role.id)) {
    await interaction.reply({
      embeds: [errorEmbed(`<@&${role.id}> не в списке мод-ролей.`)],
      ephemeral: true,
    });
    return;
  }

  const newRoles = gen.immuneRoleIds.filter((id) => id !== role.id);
  await updateGenerator(channel.id, { immuneRoleIds: newRoles });

  const rolesList = newRoles.length > 0
    ? newRoles.map((id) => `<@&${id}>`).join(', ')
    : 'нет';
  await interaction.reply({
    embeds: [successEmbed(
      `🗑️ <@&${role.id}> убрана из мод-ролей для <#${channel.id}>.\n\n` +
      `> **Текущие мод-роли:** ${rolesList}`,
    )],
    ephemeral: true,
  });

  log.info(`ModRole -${role.name} → генератор ${channel.id}`);
}

// ═══════════════════════════════════════════════
//  /voice reward — настройка наградной роли
// ═══════════════════════════════════════════════

async function configureReward(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role');
  const hours = interaction.options.getInteger('hours');
  const announceChannel = interaction.options.getChannel('announce');

  const gen = await getGenerator(channel.id);
  if (!gen) {
    await interaction.reply({
      embeds: [errorEmbed(`<#${channel.id}> не является генератором.`)],
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
      embeds: [successEmbed('🏆 Наградная система **отключена** для этого генератора.')],
      ephemeral: true,
    });
    log.info(`Reward OFF → генератор ${channel.id}`);
    return;
  }

  const thresholdMinutes = (hours ?? 50) * 60;

  await updateGenerator(channel.id, {
    rewardRoleId: role.id,
    rewardThresholdMin: thresholdMinutes,
    rewardAnnounceChId: announceChannel?.id ?? gen.rewardAnnounceChId,
  });

  const thresholdHours = thresholdMinutes / 60;
  await interaction.reply({
    embeds: [successEmbed(
      `🏆 **Наградная система настроена!**\n\n` +
      `> **Роль:** <@&${role.id}>\n` +
      `> **Порог:** ${thresholdHours} часов в войсе\n` +
      `> **Объявления:** ${announceChannel ? `<#${announceChannel.id}>` : (gen.rewardAnnounceChId ? `<#${gen.rewardAnnounceChId}>` : '*не настроены*')}\n\n` +
      `Пользователи, проведшие **${thresholdHours}ч** в войсе, автоматически получат <@&${role.id}> и расширенные права в temp-каналах ` +
      `(переименование, лимит, битрейт, регион).`,
    )],
    ephemeral: true,
  });

  log.info(`Reward: роль ${role.name}, порог ${thresholdHours}ч → генератор ${channel.id}`);
}

// ═══════════════════════════════════════════════
//  /voice stats — статистика пользователя
// ═══════════════════════════════════════════════

async function showStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  const settings = await getUserSettings(userId, guildId);
  const totalMinutes = settings?.totalVoiceMinutes ?? 0;
  const rewardGranted = settings?.rewardGranted ?? false;

  // Текущая сессия
  const session = getVoiceSession(guildId, userId);
  let currentSessionText = '';
  if (session) {
    const sessionMinutes = Math.floor((Date.now() - session.joinedAt) / 60_000);
    currentSessionText = `\n> ⏱️ Текущая сессия: **${sessionMinutes} мин**`;
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
      progressText = `\n\n🏆 Вы получили наградную роль <@&${rewardGen.rewardRoleId}>!`;
    } else {
      const progress = Math.min(100, Math.floor((totalMinutes / rewardGen.rewardThresholdMin) * 100));
      const barFull = Math.floor(progress / 10);
      const barEmpty = 10 - barFull;
      const bar = '█'.repeat(barFull) + '░'.repeat(barEmpty);
      progressText = `\n\n🏆 **Прогресс награды** (<@&${rewardGen.rewardRoleId}>)\n` +
        `> \`${bar}\` **${progress}%** (${hours}ч / ${thresholdHours}ч)`;
    }
  }

  await interaction.reply({
    embeds: [successEmbed(
      `📊 **Ваша статистика войса**\n\n` +
      `> 🕐 Всего: **${hours}ч ${mins}мин**` +
      currentSessionText +
      progressText,
    )],
    ephemeral: true,
  });
}

// ═══════════════════════════════════════════════
//  /voice top — лидерборд
// ═══════════════════════════════════════════════

async function showTop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;

  const leaders = await getVoiceLeaderboard(guildId, 10);

  if (leaders.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed('Пока нет статистики. Начните общаться в голосовых каналах!')],
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
      `🎙️ **Топ-${leaders.length} по активности в войсе**\n\n${lines.join('\n')}`,
    )],
    ephemeral: true,
  });
}

export default voiceSetup;
