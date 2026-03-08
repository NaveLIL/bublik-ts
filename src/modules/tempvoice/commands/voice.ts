// ═══════════════════════════════════════════════
//  /voice setup — настройка генератора tempvoice
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { createGenerator, deleteGenerator, getGuildGenerators, updateGenerator, getGenerator } from '../database';

const log = logger.child('TempVoice:Setup');

const voiceSetup: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Управление временными голосовыми каналами')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
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
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.voice.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'setup':      await setupGenerator(interaction); break;
      case 'remove':     await removeGenerator(interaction); break;
      case 'list':       await listGenerators(interaction); break;
      case 'addrole':    await addModRole(interaction); break;
      case 'removerole': await removeModRole(interaction); break;
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

export default voiceSetup;
