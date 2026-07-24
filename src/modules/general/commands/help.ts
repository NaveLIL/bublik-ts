// ═══════════════════════════════════════════════
//  /help — Справка по всем командам бота
//
//  Группировка по категориям через select-menu.
//  Селект работает 5 минут, видим только автору.
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
} from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import type { BublikClient } from '../../../bot';

interface CategoryEntry {
  key: string;
  emoji: string;
  title: { ru: string; en: string };
  short: { ru: string; en: string };
  body: { ru: string; en: string };
}

const CATEGORIES: CategoryEntry[] = [
  {
    key: 'earn',
    emoji: '💰',
    title: { ru: 'Заработок', en: 'Earnings' },
    short: { ru: 'Daily, work, crime, beg', en: 'Daily, work, crime, beg' },
    body: {
      ru:
        '**`/daily`** — ежедневная награда (стрик ×2 за серию)\n' +
        '**`/weekly`** — еженедельный бонус\n' +
        '**`/work`** — поработать (4ч кулдаун)\n' +
        '**`/crime`** — преступление, риск штрафа и розыска (30% шанс +⭐)\n' +
        '**`/beg`** — попросить мелочь',
      en:
        '**`/daily`** — daily reward (streak ×2 bonuses)\n' +
        '**`/weekly`** — weekly bonus\n' +
        '**`/work`** — work shift (4h cooldown)\n' +
        '**`/crime`** — commit crime, risk fine + wanted (30% chance +⭐)\n' +
        '**`/beg`** — ask for change',
    },
  },
  {
    key: 'bank',
    emoji: '🏦',
    title: { ru: 'Банк и кошелёк', en: 'Bank & wallet' },
    short: { ru: 'Баланс, депозит, перевод', en: 'Balance, deposit, transfer' },
    body: {
      ru:
        '**`/balance`** — твой баланс и стрик\n' +
        '**`/balance deposit`** — положить шекели в банк (защита от ограблений)\n' +
        '**`/balance withdraw`** — снять из банка\n' +
        '**`/balance transfer`** — перевод другому игроку\n\n' +
        '⚠️ В банк нельзя класть «грязные» деньги — сначала `/launder`.',
      en:
        '**`/balance`** — your balance and streak\n' +
        '**`/balance deposit`** — put shekels into bank (rob-protected)\n' +
        '**`/balance withdraw`** — withdraw from bank\n' +
        '**`/balance transfer`** — transfer to another player\n\n' +
        '⚠️ Dirty money is bank-blocked — `/launder` first.',
    },
  },
  {
    key: 'casino',
    emoji: '🎰',
    title: { ru: 'Казино', en: 'Casino' },
    short: { ru: 'Coinflip, dice, slots, BJ', en: 'Coinflip, dice, slots, BJ' },
    body: {
      ru:
        '**`/coinflip`** — орёл/решка ×2\n' +
        '**`/dice`** — кости (множитель за угаданное число)\n' +
        '**`/slots`** — слоты с джекпотом\n' +
        '**`/blackjack`** — блэкджек против бота',
      en:
        '**`/coinflip`** — heads/tails ×2\n' +
        '**`/dice`** — dice (multiplier for guessing the number)\n' +
        '**`/slots`** — slot machine with jackpot\n' +
        '**`/blackjack`** — blackjack vs bot',
    },
  },
  {
    key: 'crime',
    emoji: '🔫',
    title: { ru: 'Криминал', en: 'Crime' },
    short: { ru: 'Rob, heist, отмычки, отмыв', en: 'Rob, heist, picks, laundering' },
    body: {
      ru:
        '**`/rob @user`** — обчистить кошелёк игрока\n' +
        '   • +⭐ розыска при успехе (всегда), 50% при провале\n' +
        '   • украденное — «грязные деньги»\n' +
        '   • если у жертвы сейф — иммунитет или −50% добычи\n' +
        '**`/heist @user`** — собрать банду и грабить банк\n' +
        '   • от 2 до 4 человек, 5 мин на сбор\n' +
        '   • +⭐ всем участникам при успехе\n' +
        '**`/launder [сумма]`** — отмыть грязные деньги (комиссия 30%)\n' +
        '**`/shop safe`** — купить сейф (защита кошелька, 7 дней)\n' +
        '**`/shop lockpick`** — купить отмычку (+20% к шансу /rob, одноразовая)',
      en:
        '**`/rob @user`** — steal from a player\'s wallet\n' +
        '   • +⭐ wanted on success (always), 50% on fail\n' +
        '   • stolen money becomes "dirty"\n' +
        '   • victim with safe → immune or −50% loot\n' +
        '**`/heist @user`** — assemble crew and rob a bank\n' +
        '   • 2 to 4 members, 5 min assembly\n' +
        '   • +⭐ to all members on success\n' +
        '**`/launder [amount]`** — launder dirty money (30% commission)\n' +
        '**`/shop safe`** — buy a safe (wallet protection, 7 days)\n' +
        '**`/shop lockpick`** — buy a lockpick (+20% to /rob, one-shot)',
    },
  },
  {
    key: 'wanted',
    emoji: '🚨',
    title: { ru: 'Розыск и охота', en: 'Wanted & hunting' },
    short: { ru: 'Capture, wanted board', en: 'Capture, wanted board' },
    body: {
      ru:
        '**`/wanted top`** — топ самых разыскиваемых\n' +
        '**`/wanted me`** — твои звёзды и время до сгорания\n' +
        '**`/capture @user`** — поймать преступника (≥3 ⭐)\n' +
        '   • награда: 20% кошелька цели\n' +
        '   • при провале — штраф\n' +
        '   • если цель ограбила тебя — +50% к шансу\n\n' +
        '⏱ Звёзды сами сгорают (1 шт каждые 48ч).',
      en:
        '**`/wanted top`** — most wanted leaderboard\n' +
        '**`/wanted me`** — your stars + decay timer\n' +
        '**`/capture @user`** — catch a criminal (≥3 ⭐)\n' +
        '   • reward: 20% of target\'s wallet\n' +
        '   • fail = fine\n' +
        '   • if target robbed YOU — +50% chance bonus\n\n' +
        '⏱ Stars decay automatically (1 each 48h).',
    },
  },
  {
    key: 'shop',
    emoji: '🛒',
    title: { ru: 'Магазин ролей', en: 'Role shop' },
    short: { ru: 'Купи и продай роли', en: 'Buy and sell roles' },
    body: {
      ru:
        '**`/shop list`** — список товаров с названиями и ценами\n' +
        '**`/shop buy <название>`** — купить роль (есть автоподсказки!)\n' +
        '**`/shop submit`** — предложить свою роль на продажу (платно, требует одобрения админа)\n' +
        '**`/shop my`** — твои предложенные роли и заработок с продаж\n\n' +
        '🎁 Некоторые роли дают **перки**: бонус к /rob, защита от ограблений, ускоренное сгорание звёзд и др. См. описание товара.',
      en:
        '**`/shop list`** — items with names and prices\n' +
        '**`/shop buy <name>`** — buy a role (autocomplete enabled!)\n' +
        '**`/shop submit`** — offer your own role for sale (paid, admin approval required)\n' +
        '**`/shop my`** — your submitted roles and earnings\n\n' +
        '🎁 Some roles give **perks**: bonus to /rob, rob protection, faster star decay, etc. See item description.',
    },
  },
  {
    key: 'stats',
    emoji: '📊',
    title: { ru: 'Статистика', en: 'Stats' },
    short: { ru: 'Лидерборды', en: 'Leaderboards' },
    body: {
      ru:
        '**`/leaderboard`** — топ-10 богатеев\n' +
        '**`/wanted top`** — топ преступников',
      en:
        '**`/leaderboard`** — top-10 richest\n' +
        '**`/wanted top`** — top criminals',
    },
  },
  {
    key: 'utility',
    emoji: '🛠️',
    title: { ru: 'Утилиты', en: 'Utility' },
    short: { ru: 'Ping, info, language', en: 'Ping, info, language' },
    body: {
      ru:
        '**`/ping`** — задержка бота\n' +
        '**`/info`** — информация о боте\n' +
        '**`/language`** — сменить язык бота на сервере (Admin)',
      en:
        '**`/ping`** — bot latency\n' +
        '**`/info`** — bot info\n' +
        '**`/language`** — change bot language for the server (Admin)',
    },
  },
];

function lang(locale: string): 'ru' | 'en' {
  return locale.startsWith('ru') ? 'ru' : 'en';
}

function buildEmbed(catKey: string, locale: string): BublikEmbed {
  const cat = CATEGORIES.find((c) => c.key === catKey) ?? CATEGORIES[0];
  const l = lang(locale);
  return new BublikEmbed()
    .setColor(0x3498db)
    .setTitle(`${cat.emoji} ${cat.title[l]}`)
    .setDescription(cat.body[l])
    .setFooter({ text: i18n.t('commands.help.footer', locale) });
}

function buildSelect(currentKey: string, locale: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const l = lang(locale);
  const select = new StringSelectMenuBuilder()
    .setCustomId('help:category')
    .setPlaceholder(i18n.t('commands.help.select_placeholder', locale))
    .addOptions(
      CATEGORIES.map((c) => ({
        label: c.title[l],
        description: c.short[l].slice(0, 100),
        value: c.key,
        emoji: c.emoji,
        default: c.key === currentKey,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

const helpCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Справка по командам бота')
    .setDescriptionLocalizations({ 'en-US': 'Bot command reference' }),

  scope: CommandScope.Global,
  category: 'general',
  descriptionKey: 'commands.help.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const initial = 'crime'; // самое интересное — открываем сразу

    const reply = await interaction.reply({
      embeds: [buildEmbed(initial, locale)],
      components: [buildSelect(initial, locale)],
      ephemeral: true,
      fetchReply: true,
    });

    try {
      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 5 * 60_000,
        filter: (i) => i.user.id === interaction.user.id && i.customId === 'help:category',
      });

      collector.on('collect', async (i: StringSelectMenuInteraction) => {
        const next = i.values[0] ?? initial;
        await i.update({
          embeds: [buildEmbed(next, locale)],
          components: [buildSelect(next, locale)],
        }).catch(() => {});
      });

      collector.on('end', async () => {
        await interaction.editReply({ components: [] }).catch(() => {});
      });
    } catch {
      // ignore — collector failures are cosmetic
    }
  },
};

export default helpCommand;
