import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
} from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildConfig, updateGuildConfig } from '../../../core/GuildConfig';
import type { BublikClient } from '../../../bot';

const SUPPORTED_LOCALES: { value: string; nameRu: string; nameEn: string; flag: string }[] = [
  { value: 'ru', nameRu: 'Русский', nameEn: 'Russian', flag: '🇷🇺' },
  { value: 'en', nameRu: 'Английский', nameEn: 'English', flag: '🇬🇧' },
];

const command: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('language')
    .setDescription('Change bot language for this server')
    .setDescriptionLocalizations({
      ru: 'Изменить язык бота для этого сервера',
    })
    .addStringOption((opt) =>
      opt
        .setName('locale')
        .setDescription('Language / Язык')
        .setRequired(true)
        .addChoices(
          ...SUPPORTED_LOCALES.map((l) => ({
            name: `${l.flag} ${l.nameEn} / ${l.nameRu}`,
            value: l.value,
          })),
        ),
    ),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.language.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    // Требуем ManageGuild
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        embeds: [new BublikEmbed().error().setDescription(
          i18n.t('errors.no_permission', 'ru'),
        )],
        ephemeral: true,
      });
      return;
    }

    const newLocale = interaction.options.getString('locale', true);
    const guildId = interaction.guildId!;

    // Проверить, что локаль поддерживается
    if (!i18n.hasLocale(newLocale)) {
      await interaction.reply({
        embeds: [new BublikEmbed().error().setDescription(
          `Locale \`${newLocale}\` is not supported. Available: ${SUPPORTED_LOCALES.map((l) => l.value).join(', ')}`,
        )],
        ephemeral: true,
      });
      return;
    }

    const oldConfig = await getGuildConfig(guildId);
    const oldLocale = oldConfig.locale;

    if (oldLocale === newLocale) {
      await interaction.reply({
        embeds: [new BublikEmbed().warning().setDescription(
          i18n.t('commands.language.already_set', newLocale, { locale: newLocale }),
        )],
        ephemeral: true,
      });
      return;
    }

    await updateGuildConfig(guildId, { locale: newLocale });

    const localeInfo = SUPPORTED_LOCALES.find((l) => l.value === newLocale)!;

    await interaction.reply({
      embeds: [new BublikEmbed().success().setDescription(
        i18n.t('commands.language.success', newLocale, {
          flag: localeInfo.flag,
          language: newLocale === 'ru' ? localeInfo.nameRu : localeInfo.nameEn,
        }),
      )],
      ephemeral: true,
    });
  },
};

export default command;
