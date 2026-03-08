import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, GuildMember } from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import type { BublikClient } from '../../../bot';

const command: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('reload')
    .setDescription('Reload a bot module without restarting')
    .setDescriptionLocalizations({
      ru: 'Перезагрузить модуль бота без перезапуска',
    })
    .addStringOption((opt) =>
      opt
        .setName('module')
        .setDescription('Module name to reload')
        .setDescriptionLocalizations({ ru: 'Имя модуля для перезагрузки' })
        .setRequired(true)
        .setAutocomplete(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.reload.description',
  cooldown: 10,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const locale = interaction.locale.startsWith('ru') ? 'ru' : 'en'; // TODO: из GuildSettings

    // Runtime-проверка прав (setDefaultMemberPermissions — только UI-хинт, не гарантия)
    const member = interaction.member as GuildMember | null;
    if (!member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: `⛔ ${i18n.t('errors.no_permission', locale)}`,
        ephemeral: true,
      });
      return;
    }

    const moduleName = interaction.options.getString('module', true);

    await interaction.deferReply({ ephemeral: true });

    const startTime = Date.now();
    const success = await client.moduleLoader.reload(moduleName);
    const elapsed = Date.now() - startTime;

    if (success) {
      const embed = successEmbed(
        i18n.t('commands.reload.success', locale, { module: moduleName, time: String(elapsed) }),
      );
      await interaction.editReply({ embeds: [embed] });
    } else {
      const embed = errorEmbed(
        i18n.t('commands.reload.error', locale, { module: moduleName }),
      );
      await interaction.editReply({ embeds: [embed] });
    }
  },

  async autocomplete(interaction, client): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();
    const modules = client.moduleLoader.getLoadedModuleNames();

    const filtered = modules
      .filter((name) => name.toLowerCase().includes(focused))
      .slice(0, 25);

    await interaction.respond(
      filtered.map((name) => ({ name, value: name })),
    );
  },
};

export default command;
