import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getInventory, consumeInventoryItem } from '../inventory';
import { withFinancialLock } from '../profile';
import { formatPerksInline } from '../perks';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError } from '../embeds';
import { EMOJI } from '../constants';
import { canProcessEconomyCollector, registerEconomyCollector } from '../collector-lifecycle';

const inventoryCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Открыть ваш личный инвентарь предметов'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.inventory.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const locale = await getGuildLocale(guildId);

    const reply = await renderInventory(interaction, guildId, userId, locale);
    if (!reply) return;

    // Сборщик компонентов для интерактивного переключения
    const message = await interaction.reply(reply);
    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === userId,
      time: 120_000,
    });
    registerEconomyCollector(collector);

    let selectedItemKey: string | null = null;

    collector.on('collect', async (i) => {
      if (!canProcessEconomyCollector(guildId)) {
        collector.stop('guild_not_allowed');
        await i.reply({ content: '⛔ Этот сервер больше не авторизован.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await i.deferUpdate();

      if (i.isStringSelectMenu() && i.customId === 'inventory_select_item') {
        selectedItemKey = i.values[0];
        const detailReply = await renderItemDetail(guildId, userId, selectedItemKey, locale);
        await interaction.editReply(detailReply);
      } else if (i.isButton()) {
        if (i.customId === 'inv_back') {
          selectedItemKey = null;
          const mainReply = await renderInventory(interaction, guildId, userId, locale);
          await interaction.editReply(mainReply);
        } else if (i.customId === 'inv_use' && selectedItemKey) {
          const itemKey = selectedItemKey;
          const result = await withFinancialLock(guildId, userId, async () => {
            const db = getDatabase();
            return db.$transaction(async (tx) => {
              if (itemKey === 'safe') {
                const consumed = await consumeInventoryItem(tx, guildId, userId, 'safe', 1);
                if (!consumed) return { success: false, error: 'no_item' };

                const now = Date.now();
                const profile = await tx.economyProfile.findUnique({
                  where: { guildId_userId: { guildId, userId } }
                });
                if (!profile) return { success: false, error: 'no_profile' };

                const currentSafeTime = profile.safeUntil ? profile.safeUntil.getTime() : now;
                const baseTime = currentSafeTime > now ? currentSafeTime : now;
                const durationMs = 7 * 24 * 3600 * 1000; // 7 дней
                const newSafeUntil = new Date(baseTime + durationMs);

                await tx.economyProfile.update({
                  where: { guildId_userId: { guildId, userId } },
                  data: { safeUntil: newSafeUntil }
                });

                return { success: true, until: newSafeUntil };
              }
              return { success: false, error: 'not_usable' };
            });
          });

          if (result && result.success && result.until) {
            selectedItemKey = null;
            const mainReply = await renderInventory(interaction, guildId, userId, locale);
            mainReply.content = `✅ **Предмет успешно активирован!** Защита сейфа продлена до <t:${Math.floor(result.until.getTime() / 1000)}:F>.`;
            await interaction.editReply(mainReply);
          } else {
            await interaction.followUp({
              embeds: [ecoError('Не удалось активировать предмет. Возможно, его уже нет в инвентаре.')],
              flags: MessageFlags.Ephemeral
            });
          }
        } else if (i.customId === 'inv_discard' && selectedItemKey) {
          const itemKey = selectedItemKey;
          const result = await withFinancialLock(guildId, userId, async () => {
            const db = getDatabase();
            return db.$transaction(async (tx) => {
              return consumeInventoryItem(tx, guildId, userId, itemKey, 1);
            });
          });

          if (result) {
            selectedItemKey = null;
            const mainReply = await renderInventory(interaction, guildId, userId, locale);
            mainReply.content = `🗑️ **Один предмет был выброшен (уничтожен).**`;
            await interaction.editReply(mainReply);
          } else {
            await interaction.followUp({
              embeds: [ecoError('Не удалось выбросить предмет.')],
              flags: MessageFlags.Ephemeral
            });
          }
        }
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'module_unload' || !canProcessEconomyCollector(guildId)) return;
      // Удаляем компоненты управления при истечении времени
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};

/**
 * Рендеринг основного меню инвентаря
 */
async function renderInventory(interaction: any, guildId: string, userId: string, locale: string) {
  const items = await getInventory(guildId, userId);

  const embed = new BublikEmbed()
    .setColor(0x70a1ff)
    .setTitle(`${EMOJI.SHOP} Личный инвентарь предметов`)
    .setDescription(
      `Добро пожаловать в ваш инвентарь!\n` +
      `Здесь хранятся все ваши купленные расходники, защитные сейфы и кастомные предметы.\n\n` +
      (items.length === 0
        ? `*Ваш инвентарь пуст. Приобрести полезные предметы можно в* \`/shop\`!`
        : items
            .map(
              (item) =>
                `• **${item.name}** × \`${item.quantity} шт.\`\n` +
                `  *${item.description || 'Нет описания'}*\n` +
                (item.perks ? `  ⚡ **Перки:** ${formatPerksInline(item.perks, locale)}\n` : '')
            )
            .join('\n'))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>();

  if (items.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('inventory_select_item')
      .setPlaceholder('Выберите предмет для управления...');

    for (const item of items) {
      select.addOptions({
        label: `${item.name.replace(/[^a-zA-Zа-яА-Я0-9\s()]/g, '').trim()} (${item.quantity} шт.)`,
        value: item.itemKey,
        description: item.description ? (item.description.length > 100 ? item.description.substring(0, 97) + '...' : item.description) : undefined,
      });
    }
    row.addComponents(select);
  }

  return {
    content: '',
    embeds: [embed],
    components: items.length > 0 ? [row] : [],
  };
}

/**
 * Рендеринг меню детальной информации предмета
 */
async function renderItemDetail(guildId: string, userId: string, itemKey: string, locale: string) {
  const items = await getInventory(guildId, userId);
  const item = items.find((i) => i.itemKey === itemKey);

  if (!item) {
    return {
      embeds: [ecoError('Предмет не найден в вашем инвентаре.')],
      components: [],
    };
  }

  const embed = new BublikEmbed()
    .setColor(0x1e90ff)
    .setTitle(`🎒 Управление: ${item.name}`)
    .setDescription(
      `• **Количество:** \`${item.quantity} шт.\`\n` +
      `• **Тип:** \`${item.type}\`\n` +
      `• **Описание:** *${item.description || 'Нет описания'}*\n` +
      (item.perks ? `• ⚡ **Характеристики:** ${formatPerksInline(item.perks, locale)}\n` : '') +
      (item.isCustom ? `• 🛠️ **Кастомный лот** (Создатель: <@${item.creatorId}>)` : '')
    );

  const row = new ActionRowBuilder<ButtonBuilder>();

  // Кнопка использования
  const useBtn = new ButtonBuilder()
    .setCustomId('inv_use')
    .setLabel('Использовать')
    .setStyle(ButtonStyle.Success);

  // Использовать (активировать) можно только Сейф.
  if (itemKey !== 'safe') {
    useBtn.setDisabled(true);
    useBtn.setLabel('Авто-активный');
  }

  const discardBtn = new ButtonBuilder()
    .setCustomId('inv_discard')
    .setLabel('Выбросить (1 шт.)')
    .setStyle(ButtonStyle.Danger);

  const backBtn = new ButtonBuilder()
    .setCustomId('inv_back')
    .setLabel('Назад в инвентарь')
    .setStyle(ButtonStyle.Secondary);

  row.addComponents(useBtn, discardBtn, backBtn);

  return {
    embeds: [embed],
    components: [row],
  };
}

export default inventoryCommand;
