// ═══════════════════════════════════════════════
//  /br — слэш-команда: rating, search, panel
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionsBitField,
  TextChannel,
  MessageFlags,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { errorEmbed, successEmbed } from '../../../core/EmbedBuilder';
import { Config } from '../../../config';

import {
  getEntriesForBr,
  getAvailableBrs,
  getAdjacentBrs,
  searchTech,
  upsertPanel,
  cloneBrDatabase,
} from '../database';
import {
  buildBrEmbed,
  buildPanelHubEmbed,
  buildRotationGraphEmbed,
  buildRotationStatusEmbed,
  buildSearchEmbed,
} from '../embeds';
import {
  buildBrSelect,
  buildCategorySelect,
  buildNavButtons,
  buildPanelButtons,
  buildRotationActionButtons,
} from '../components';
import { getGuildRotation, getRotationDisplayBr, getRotationSnapshot, parseRotationJson, setGuildRotation } from '../rotation';
import { canImportBrSource } from '../policy';

const log = logger.child('BR:Command');

const brCommand: BublikCommand = {
  scope: CommandScope.Guild,
  category: 'utility',
  descriptionKey: 'br.cmd_description',

  data: new SlashCommandBuilder()
    .setName('br')
    .setDescription('War Thunder — справочник по БР')

    .addSubcommand((sub) =>
      sub
        .setName('rating')
        .setDescription('Показать технику для конкретного БР')
        .addStringOption((opt) =>
          opt.setName('value').setDescription('БР (например, 10.3)').setRequired(true).setAutocomplete(true),
        ),
    )

    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Найти технику по названию')
        .addStringOption((opt) =>
          opt.setName('query').setDescription('Название техники (часть)').setRequired(true).setMinLength(2),
        ),
    )

    .addSubcommand((sub) =>
      sub
        .setName('current')
        .setDescription('Показать технику для текущего БР по расписанию'),
    )

    .addSubcommand((sub) =>
      sub
        .setName('rotation')
        .setDescription('Текущий статус ротации БР'),
    )

    .addSubcommand((sub) =>
      sub
        .setName('schedule')
        .setDescription('Показать полный график ротации БР'),
    )

    .addSubcommand((sub) =>
      sub
        .setName('rotation-update')
        .setDescription('[Админ] Обновить расписание ротации (JSON или текст)')
        .addAttachmentOption((opt) =>
          opt.setName('file').setDescription('Файл расписания (JSON или текст)').setRequired(true),
        ),
    )

    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('[Админ] Развернуть панель БР в канале')
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Канал для панели').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('import-main-db')
        .setDescription('[Админ] Скопировать базу техники с другого сервера')
        .addStringOption((opt) =>
          opt
            .setName('source_guild_id')
            .setDescription('ID сервера-источника (по умолчанию главный EREZ)')
            .setRequired(false),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    if (!interaction.guildId) return;
    const sub = interaction.options.getSubcommand();
    const locale = await getGuildLocale(interaction.guildId);

    if (sub === 'rating') {
      const value = interaction.options.getString('value', true).trim();
      const all = await getAvailableBrs(interaction.guildId);
      if (!all.includes(value)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.unknown_br', locale, { br: value }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const entries = await getEntriesForBr(interaction.guildId, value);
      const { prev, next } = await getAdjacentBrs(interaction.guildId, value);
      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false;
      await interaction.reply({
        embeds: [buildBrEmbed(interaction.guild?.name ?? '', value, entries, locale)],
        components: [
          buildBrSelect(locale, all, value),
          buildCategorySelect(locale, '__all__'),
          ...buildNavButtons(locale, value, prev, next, isAdmin),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'search') {
      const q = interaction.options.getString('query', true).trim();
      const results = await searchTech(interaction.guildId, q, 30);
      await interaction.reply({
        embeds: [buildSearchEmbed(q, results, locale)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'current') {
      const periods = await getGuildRotation(interaction.guildId);
      const snapshot = getRotationSnapshot(periods);
      const currentBr = getRotationDisplayBr(snapshot, periods);

      if (!currentBr) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.rotation_no_current', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const all = await getAvailableBrs(interaction.guildId);
      if (!all.includes(currentBr)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.unknown_br', locale, { br: currentBr }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const entries = await getEntriesForBr(interaction.guildId, currentBr);
      const { prev, next } = await getAdjacentBrs(interaction.guildId, currentBr);
      const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false;

      await interaction.reply({
        embeds: [buildBrEmbed(interaction.guild?.name ?? '', currentBr, entries, locale)],
        components: [
          buildBrSelect(locale, all, currentBr),
          buildCategorySelect(locale, '__all__'),
          ...buildNavButtons(locale, currentBr, prev, next, isAdmin),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'rotation') {
      const periods = await getGuildRotation(interaction.guildId);
      const snapshot = getRotationSnapshot(periods);
      await interaction.reply({
        embeds: [buildRotationStatusEmbed(locale, snapshot)],
        components: [buildRotationActionButtons(locale, snapshot.current?.rating ?? null, { includeNext: false })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'schedule') {
      const periods = await getGuildRotation(interaction.guildId);
      const snapshot = getRotationSnapshot(periods);
      await interaction.reply({
        embeds: [buildRotationGraphEmbed(locale, periods, snapshot.today)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'rotation-update') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const file = interaction.options.getAttachment('file', true);
      const lowerName = file.name.toLowerCase();
      const looksLikeText = lowerName.endsWith('.json') || lowerName.endsWith('.txt') || lowerName.endsWith('.md');
      if (!looksLikeText) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.rotation_update_bad_file', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        const res = await fetch(file.url);
        const body = await res.text();
        const periods = parseRotationJson(body);
        await setGuildRotation(interaction.guildId, periods);
        const snapshot = getRotationSnapshot(periods);

        await interaction.reply({
          embeds: [successEmbed(i18n.t('br.rotation_update_done', locale, { count: String(periods.length) }))],
          components: [buildRotationActionButtons(locale, snapshot.current?.rating ?? null, { includeNext: false })],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        log.error('Не удалось обновить ротацию BR', { error: String(err) });
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.rotation_update_failed', locale))],
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'panel') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      try {
        const periods = await getGuildRotation(interaction.guildId);
        const snapshot = getRotationSnapshot(periods);
        const brs = await getAvailableBrs(interaction.guildId);
        const fallbackBr = brs[0] ?? null;

        const msg = await channel.send({
          embeds: [buildPanelHubEmbed(locale, snapshot, periods, fallbackBr)],
          components: buildPanelButtons(locale),
        });
        await upsertPanel(interaction.guildId, {
          panelChannelId: channel.id,
          panelMessageId: msg.id,
          defaultBr: fallbackBr,
        });
        await interaction.reply({
          embeds: [successEmbed(i18n.t('br.panel_deployed', locale, { channel: `<#${channel.id}>` }))],
          flags: MessageFlags.Ephemeral,
        });
        log.info(`BR panel deployed: guild=${interaction.guildId} channel=${channel.id} by ${interaction.user.tag}`);
      } catch (err) {
        log.error('Не удалось развернуть BR панель', { error: String(err) });
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.panel_failed', locale))],
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'import-main-db') {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
          embeds: [errorEmbed(i18n.t('br.no_admin', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const sourceGuildId = interaction.options.getString('source_guild_id') || Config.brTemplateGuildId;

      // The configured catalogue is intentionally shareable. Reading another
      // tenant's rows requires equivalent authority in that source guild (or
      // the explicitly configured bot owner), otherwise a target-guild admin
      // could enumerate and copy private cross-guild data by ID.
      const triviallyAuthorized = canImportBrSource({
        sourceGuildId,
        targetGuildId: interaction.guildId,
        templateGuildId: Config.brTemplateGuildId,
        actorId: interaction.user.id,
        ownerId: Config.ownerId,
        actorCanManageSourceGuild: false,
      });

      if (!triviallyAuthorized) {
        const sourceGuild = client.guilds.cache.get(sourceGuildId);
        const sourceMember = sourceGuild
          ? await sourceGuild.members.fetch(interaction.user.id).catch(() => null)
          : null;

        if (!canImportBrSource({
          sourceGuildId,
          targetGuildId: interaction.guildId,
          templateGuildId: Config.brTemplateGuildId,
          actorId: interaction.user.id,
          ownerId: Config.ownerId,
          actorCanManageSourceGuild:
            sourceMember?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false,
        })) {
          await interaction.editReply({
            embeds: [
              errorEmbed(
                '❌ Импорт из произвольного сервера разрешён только его администратору или владельцу бота.',
              ),
            ],
          });
          return;
        }
      }

      try {
        const count = await cloneBrDatabase(sourceGuildId, interaction.guildId);
        if (count === 0) {
          await interaction.editReply({
            embeds: [errorEmbed(`❌ Не найдена техника для импорта на сервере-источнике (\`${sourceGuildId}\`).`)],
          });
          return;
        }

        await interaction.editReply({
          embeds: [successEmbed(`✅ Успешно импортировано **${count}** единиц техники с сервера \`${sourceGuildId}\` на этот сервер!`)],
        });
      } catch (err) {
        log.error('Ошибка клонирования базы БР', err);
        await interaction.editReply({
          embeds: [errorEmbed('❌ Произошла ошибка во время импорта базы техники.')],
        });
      }
      return;
    }
  },

  async autocomplete(interaction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused().toString().trim();
    const all = await getAvailableBrs(interaction.guildId);
    const filtered = focused
      ? all.filter((b) => b.startsWith(focused) || b.includes(focused))
      : all;
    await interaction.respond(filtered.slice(0, 25).map((b) => ({ name: `БР ${b}`, value: b })));
  },
};

export default brCommand;
