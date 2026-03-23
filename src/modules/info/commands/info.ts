import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from 'discord.js';
import { BublikCommand, CommandScope, CommandCategory } from '../../../types';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import type { BublikClient } from '../../../bot';
import { Config } from '../../../config';
import { formatUptime, formatBytes, categoryEmojis } from '../../../utils/helpers';

const INFO_TIMEOUT = 120_000; // 2 минуты

const command: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Information panel — commands, modules, bot stats')
    .setDescriptionLocalizations({
      ru: 'Информационная панель — команды, модули, статистика бота',
    }),

  scope: CommandScope.Global,
  category: 'info',
  descriptionKey: 'commands.info.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const locale = interaction.locale.startsWith('ru') || interaction.guildLocale?.startsWith('ru') ? 'ru' : 'en';
    // TODO: получать из GuildSettings / UserSettings БД

    // ── Главный embed ───────────────────────
    const mainEmbed = buildMainEmbed(client, locale);

    // ── SelectMenu с категориями ────────────
    const categories = getUniqueCategories(client);

    /** Создать ActionRow с селектом, где default = текущая страница */
    const buildRow = (currentPage: string) =>
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        buildCategorySelect(categories, locale, currentPage),
      );

    const response = await interaction.reply({
      embeds: [mainEmbed],
      components: [buildRow('__main__')],
      fetchReply: true,
    });

    // ── Collector для интерактива ────────────
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: INFO_TIMEOUT,
      filter: (i) => i.user.id === interaction.user.id,
    });

    collector.on('collect', async (menuInteraction: StringSelectMenuInteraction) => {
      const selected = menuInteraction.values[0];

      if (selected === '__main__') {
        await menuInteraction.update({
          embeds: [buildMainEmbed(client, locale)],
          components: [buildRow('__main__')],
        });
        return;
      }

      if (selected === '__modules__') {
        await menuInteraction.update({
          embeds: [buildModulesEmbed(client, locale)],
          components: [buildRow('__modules__')],
        });
        return;
      }

      // Категория команд
      const categoryEmbed = buildCategoryEmbed(client, selected, locale);
      await menuInteraction.update({
        embeds: [categoryEmbed],
        components: [buildRow(selected)],
      });
    });

    collector.on('end', async () => {
      try {
        await response.edit({ components: [] });
      } catch {
        // Сообщение могло быть удалено
      }
    });
  },
};

// ── Builders ──────────────────────────────────

function buildMainEmbed(client: BublikClient, locale: string): BublikEmbed {
  const totalCommands = client.commandRegistry.getAllCommands().size;
  const totalModules = client.moduleLoader.getAllModules().length;
  const uptime = client.uptime ?? 0;
  const memUsage = process.memoryUsage();
  const guilds = client.guilds.cache.size;
  const users = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);

  return new BublikEmbed()
    .setAuthor({
      name: `${Config.botName} — ${i18n.t('info.panel.title', locale)}`,
      iconURL: client.user?.displayAvatarURL({ size: 64 }),
    })
    .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
    .setDescription(i18n.t('info.panel.description', locale))
    .addFields(
      {
        name: `📊 ${i18n.t('info.panel.stats', locale)}`,
        value: [
          `> 🏠 ${i18n.t('info.panel.guilds', locale)}: **${guilds}**`,
          `> 👥 ${i18n.t('info.panel.users', locale)}: **${users.toLocaleString()}**`,
          `> ⚡ ${i18n.t('info.panel.commands', locale)}: **${totalCommands}**`,
          `> 📦 ${i18n.t('info.panel.modules', locale)}: **${totalModules}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: `🖥️ ${i18n.t('info.panel.system', locale)}`,
        value: [
          `> ⏱ Uptime: **${formatUptime(uptime)}**`,
          `> 💾 RAM: **${formatBytes(memUsage.heapUsed)}**`,
          `> 📡 Ping: **${client.ws.ping}ms**`,
          `> 🟢 Node: **${process.version}**`,
        ].join('\n'),
        inline: true,
      },
    )
    .info();
}

function buildModulesEmbed(client: BublikClient, locale: string): BublikEmbed {
  const modules = client.moduleLoader.getAllModules();

  const embed = new BublikEmbed()
    .setAuthor({
      name: `${Config.botName} — ${i18n.t('info.modules.title', locale)}`,
      iconURL: client.user?.displayAvatarURL({ size: 64 }),
    })
    .setDescription(i18n.t('info.modules.description', locale));

  for (const mod of modules) {
    const cmds = mod.module.commands.map((c) => `\`/${c.data.name}\``).join(', ') || '—';
    const status = mod.state === 'loaded' ? '🟢' : mod.state === 'error' ? '🔴' : '⚫';

    embed.addFields({
      name: `${status} ${mod.module.name} v${mod.module.version}`,
      value: `> ${i18n.t(mod.module.descriptionKey, locale)}\n> ${i18n.t('info.modules.commands', locale)}: ${cmds}`,
      inline: false,
    });
  }

  return embed.info();
}

function buildCategoryEmbed(client: BublikClient, category: string, locale: string): BublikEmbed {
  const commands = client.commandRegistry.getCommandsByCategory(category);
  const emoji = categoryEmojis[category] || '📁';

  const embed = new BublikEmbed()
    .setAuthor({
      name: `${Config.botName} — ${emoji} ${i18n.t(`categories.${category}`, locale)}`,
      iconURL: client.user?.displayAvatarURL({ size: 64 }),
    });

  if (commands.length === 0) {
    embed.setDescription(i18n.t('info.category.empty', locale));
    return embed.info();
  }

  const lines = commands.map((r) => {
    const name = r.command.data.name;
    const desc = i18n.t(r.command.descriptionKey, locale);
    const scope = r.command.scope === CommandScope.Global ? '🌐' : '🏠';
    return `${scope} **/${name}** — ${desc}`;
  });

  embed.setDescription(lines.join('\n'));
  return embed.info();
}

function getUniqueCategories(client: BublikClient): string[] {
  const categories = new Set<string>();
  for (const [, reg] of client.commandRegistry.getAllCommands()) {
    categories.add(reg.command.category);
  }
  return Array.from(categories);
}

function buildCategorySelect(categories: string[], locale: string, currentPage: string): StringSelectMenuBuilder {
  const options = [
    {
      label: i18n.t('info.select.main', locale),
      value: '__main__',
      emoji: '🏠',
      description: i18n.t('info.select.main_desc', locale),
      default: currentPage === '__main__',
    },
    {
      label: i18n.t('info.select.modules', locale),
      value: '__modules__',
      emoji: '📦',
      description: i18n.t('info.select.modules_desc', locale),
      default: currentPage === '__modules__',
    },
    ...categories.map((cat) => ({
      label: i18n.t(`categories.${cat}`, locale),
      value: cat,
      emoji: categoryEmojis[cat] || '📁',
      description: i18n.t(`info.select.category_desc`, locale, { category: cat }),
      default: currentPage === cat,
    })),
  ];

  return new StringSelectMenuBuilder()
    .setCustomId('info_panel_select')
    .setPlaceholder(i18n.t('info.select.placeholder', locale))
    .addOptions(options.slice(0, 25)); // Discord limit
}

export default command;
