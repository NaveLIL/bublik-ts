import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { successEmbed, errorEmbed, warnEmbed } from '../../../core/EmbedBuilder';
import type { BublikClient } from '../../../bot';
import { addAllowedGuild, removeAllowedGuild, getAllowedGuildsList } from '../../../core/Whitelist';
import { leaveUnauthorizedGuild } from '../../../core/EventHandler';

const command: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage whitelisted Discord servers (Owner only)')
    .setDescriptionLocalizations({
      ru: 'Управление белым списком серверов Discord (Только владелец)',
    })
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a server to the whitelist')
        .setDescriptionLocalizations({ ru: 'Добавить сервер в белый список' })
        .addStringOption((opt) =>
          opt
            .setName('guild_id')
            .setDescription('Discord server ID')
            .setDescriptionLocalizations({ ru: 'ID Discord сервера' })
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a server from the whitelist')
        .setDescriptionLocalizations({ ru: 'Удалить сервер из белого списка' })
        .addStringOption((opt) =>
          opt
            .setName('guild_id')
            .setDescription('Discord server ID')
            .setDescriptionLocalizations({ ru: 'ID Discord сервера' })
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List all whitelisted servers')
        .setDescriptionLocalizations({ ru: 'Показать все разрешённые серверы' }),
    ),

  scope: CommandScope.Global,
  category: 'admin',
  descriptionKey: 'commands.whitelist.description',
  ownerOnly: true,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    if (subcommand === 'add') {
      const guildId = interaction.options.getString('guild_id', true).trim();
      const success = await addAllowedGuild(guildId);

      if (success) {
        const targetGuild = client.guilds.cache.get(guildId);
        const nameText = targetGuild ? ` **${targetGuild.name}**` : '';
        await interaction.editReply({
          embeds: [successEmbed(`✅ Сервер${nameText} (\`${guildId}\`) добавлен в белый список.`)],
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('❌ Не удалось добавить сервер в белый список.')],
        });
      }
    } else if (subcommand === 'remove') {
      const guildId = interaction.options.getString('guild_id', true).trim();
      const success = await removeAllowedGuild(guildId);

      if (success) {
        const targetGuild = client.guilds.cache.get(guildId);
        const nameText = targetGuild ? ` **${targetGuild.name}**` : '';
        await interaction.editReply({
          embeds: [successEmbed(`✅ Сервер${nameText} (\`${guildId}\`) удалён из белого списка.`)],
        });

        // Removing access is an immediate security boundary. Hide the guild
        // synchronously so background schedulers cannot mutate it while the
        // REST leave request is in flight (or if Discord is temporarily down).
        if (targetGuild) {
          client.guilds.cache.delete(guildId);
          await leaveUnauthorizedGuild(targetGuild);
        }
      } else {
        await interaction.editReply({
          embeds: [errorEmbed('❌ Не удалось удалить сервер из белого списка.')],
        });
      }
    } else if (subcommand === 'list') {
      const list = getAllowedGuildsList();
      if (list.length === 0) {
        await interaction.editReply({
          embeds: [warnEmbed('ℹ️ Белый список пуст. Доступ закрыт для всех серверов.')],
        });
        return;
      }

      const lines = list.map((id) => {
        const guild = client.guilds.cache.get(id);
        const nameText = guild ? ` — **${guild.name}**` : ' *(бот не состоит на сервере)*';
        return `• \`${id}\`${nameText}`;
      });

      await interaction.editReply({
        embeds: [
          successEmbed(lines.join('\n'))
            .setTitle('📋 Разрешённые серверы (Вайтлист)'),
        ],
      });
    }
  },
};

export default command;
