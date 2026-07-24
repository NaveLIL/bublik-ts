// ═══════════════════════════════════════════════
//  /slots — Слот-машина
//
//  3 барабана. Комбинации:
//  • 3 одинаковых 💰 = джекпот (x10)
//  • 3 одинаковых = x5
//  • 2 одинаковых = x2
//  • 0 совпадений = проигрыш
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ComponentType,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile, invalidateConfigCache, invalidateProfileCache } from '../database';
import { applyWalletDeltaInTransaction, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { getDatabase } from '../../../core/Database';
import { ecoError } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX } from '../constants';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { newsCasinoWin, newsSlotsProgressiveJackpot } from '../news';
import { secureRandomFloat } from '../random';
import { canProcessEconomyCollector, registerEconomyCollector } from '../collector-lifecycle';

const log = logger.child('Economy:Slots');

function spinWeightedReel(): string {
  const r = secureRandomFloat() * 100;
  if (r < 28) return '🍒';      // 28%
  if (r < 50) return '🍋';      // 22%
  if (r < 66) return '🍇';      // 16%
  if (r < 78) return '🍉';      // 12%
  if (r < 87) return '🔔';      // 9%
  if (r < 93) return '🍀';      // 6%
  if (r < 97) return '💎';      // 4%
  if (r < 99) return '7️⃣';      // 2%
  return '💰';                  // 1%
}

function spinSlots(): [string, string, string] {
  return [spinWeightedReel(), spinWeightedReel(), spinWeightedReel()];
}

function getMultiplier(reels: [string, string, string]): { multiplier: number; type: string } {
  const [a, b, c] = reels;

  if (a === b && b === c) {
    if (a === '💰') return { multiplier: CASINO_DEFAULTS.slotsJackpotMultiplier, type: 'jackpot' };
    return { multiplier: CASINO_DEFAULTS.slotsTripleMultiplier, type: 'triple' };
  }

  if (a === b || b === c || a === c) {
    return { multiplier: CASINO_DEFAULTS.slotsDoubleMultiplier, type: 'double' };
  }

  return { multiplier: 0, type: 'lose' };
}

function getBetStep(bet: number): number {
  if (bet < 1000) return 100;
  if (bet < 10000) return 1000;
  return 5000;
}

function getSlotsButtons(disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('bet_minus')
      .setLabel('➖')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('spin')
      .setLabel('🎰 Крутить!')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('bet_plus')
      .setLabel('➕')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('bet_max')
      .setLabel('💰 Макс')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('quit')
      .setLabel('❌ Выйти')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

const slotsCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('Игровой автомат слотов с интерактивной панелью')
    .addIntegerOption((opt) =>
      opt
        .setName('bet')
        .setDescription('Ставка (₪)')
        .setMinValue(1)
        .setRequired(false),
    ) as SlashCommandBuilder,

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.slots.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const locale = await getGuildLocale(guildId);

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], ephemeral: true });
      return;
    }
    if (config.casinoEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_casino_disabled', locale))], ephemeral: true });
      return;
    }

    const minBet = config.casinoMinBet ?? CASINO_DEFAULTS.minBet;
    const maxBet = config.casinoMaxBet ?? CASINO_DEFAULTS.maxBet;

    // Начальная ставка
    let currentBet = interaction.options.getInteger('bet') ?? minBet;
    if (currentBet < minBet) currentBet = minBet;
    if (currentBet > maxBet) currentBet = maxBet;

    // Профиль игрока для начального отображения баланса
    let profile = await getOrCreateProfile(guildId, userId);
    let wallet = profile.wallet;

    const freshConfig = await getDatabase().economyConfig.findUnique({ where: { guildId } });
    let jackpot = freshConfig?.slotsJackpot ?? CASINO_DEFAULTS.slotsJackpotSeed;

    const buildEmbed = (
      reels: string[],
      spinState: 'idle' | 'spinning' | 'stop1' | 'stop2' | 'result',
      net = 0,
      won = false,
      winType = 'lose',
      multiplier = 0,
    ) => {
      const isRu = locale === 'ru';
      const authorName = isRu
        ? `🎰 Кошерный Слот EREZ | Игрок: ${interaction.user.displayName}`
        : `🎰 Kosher Slot EREZ | Player: ${interaction.user.displayName}`;

      const embed = new BublikEmbed()
        .setAuthor({
          name: authorName,
          iconURL: interaction.user.displayAvatarURL({ size: 64 }),
        });

      const textJackpotLabel = isRu ? 'Накопленный джекпот' : 'Accumulated jackpot';
      const textBetLabel = isRu ? 'Текущая ставка' : 'Current bet';
      const textWalletLabel = isRu ? 'Кошелёк' : 'Wallet';

      let reelsText = '';
      if (spinState === 'idle') {
        reelsText = `🎰 **[ ❔ | ❔ | ❔ ]**`;
        embed.setColor(0x3498db).setDescription(
          `${reelsText}\n\n` +
          `💰 ${textJackpotLabel}: **${fmt(jackpot)} ₪**\n` +
          `💵 ${textBetLabel}: **${fmt(currentBet)} ₪**\n` +
          `${EMOJI.WALLET} ${textWalletLabel}: **${fmt(wallet)} ₪**\n\n` +
          (isRu
            ? `*Нажимайте на кнопки внизу, чтобы настроить ставку и крутить барабаны!*`
            : `*Click the buttons below to adjust your bet and spin the reels!*`),
        );
      } else if (spinState === 'spinning') {
        reelsText = `🎰 **[ 🔄 | 🔄 | 🔄 ]**`;
        embed.setColor(0x95a5a6).setDescription(
          `${reelsText}\n\n` +
          (isRu ? `⏳ *Крутим барабаны...*` : `⏳ *Spinning the reels...*`),
        );
      } else if (spinState === 'stop1') {
        reelsText = `🎰 **[ ${reels[0]} | 🔄 | 🔄 ]**`;
        embed.setColor(0x95a5a6).setDescription(
          `${reelsText}\n\n` +
          (isRu ? `⏳ *Первый барабан остановился!*` : `⏳ *First reel stopped!*`),
        );
      } else if (spinState === 'stop2') {
        reelsText = `🎰 **[ ${reels[0]} | ${reels[1]} | 🔄 ]**`;
        embed.setColor(0x95a5a6).setDescription(
          `${reelsText}\n\n` +
          (isRu ? `⏳ *Второй барабан остановился!*` : `⏳ *Second reel stopped!*`),
        );
      } else if (spinState === 'result') {
        reelsText = `${EMOJI.SLOTS} **[ ${reels.join(' | ')} ]**`;
        const isJackpot = winType === 'jackpot';
        embed.setColor(isJackpot ? 0xf1c40f : won ? 0x2ecc71 : 0xe74c3c);

        const typeNames: Record<string, string> = {
          jackpot: '🎉 **ПРОГРЕССИВНЫЙ ДЖЕКПОТ!**',
          triple: i18n.t('economy.cmd.slots.type_triple', locale),
          double: i18n.t('economy.cmd.slots.type_double', locale),
          lose: i18n.t('economy.cmd.slots.type_lose', locale),
        };

        embed.setDescription(
          `${reelsText}\n\n` +
          `${isJackpot ? typeNames.jackpot : typeNames[winType]}` +
          (won
            ? isJackpot
              ? ` → **+${fmt(net)}**`
              : ` **x${multiplier}** → **+${fmt(net)}**`
            : ` ${i18n.t('economy.cmd.slots.embed_lose', locale, { amount: fmt(Math.abs(net)) })}`) +
          `\n\n` +
          `💰 ${isJackpot ? (isRu ? 'Начальный' : 'Initial') : (isRu ? 'Накопленный' : 'Accumulated')} джекпот: **${fmt(jackpot)} ₪**\n` +
          `💵 ${textBetLabel}: **${fmt(currentBet)} ₪**\n` +
          `${EMOJI.WALLET} ${textWalletLabel}: **${fmt(wallet)} ₪**`,
        );
      }

      return embed;
    };

    // Отправка стартового сообщения с кнопками
    const response = await interaction.reply({
      embeds: [buildEmbed([], 'idle')],
      components: [getSlotsButtons(false)],
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      idle: 60_000, // 60 секунд бездействия
    });
    registerEconomyCollector(collector);

    collector.on('collect', async (i) => {
      if (!canProcessEconomyCollector(guildId)) {
        collector.stop('guild_not_allowed');
        await i.reply({ content: '⛔ Этот сервер больше не авторизован.', ephemeral: true }).catch(() => {});
        return;
      }
      if (i.user.id !== userId) {
        await i.reply({
          content: '❌ Этот игровой автомат занят другим игроком! Используйте `/slots`, чтобы открыть свой.',
          ephemeral: true,
        });
        return;
      }

      // Продлеваем кулдаун коллектора при активности
      collector.resetTimer();

      try {
        if (i.customId === 'quit') {
          await i.deferUpdate();
          collector.stop('user_quit');
          return;
        }

        // Обновить профиль игрока перед настройкой ставки
        profile = await getOrCreateProfile(guildId, userId);
        wallet = profile.wallet;

        if (i.customId === 'bet_minus') {
          const step = getBetStep(currentBet);
          currentBet = Math.max(minBet, currentBet - step);
          await i.update({
            embeds: [buildEmbed([], 'idle')],
          });
          return;
        }

        if (i.customId === 'bet_plus') {
          const step = getBetStep(currentBet);
          currentBet = Math.min(maxBet, wallet, currentBet + step);
          if (currentBet < minBet) currentBet = minBet;
          await i.update({
            embeds: [buildEmbed([], 'idle')],
          });
          return;
        }

        if (i.customId === 'bet_max') {
          currentBet = Math.min(maxBet, wallet);
          if (currentBet < minBet) currentBet = minBet;
          await i.update({
            embeds: [buildEmbed([], 'idle')],
          });
          return;
        }

        if (i.customId === 'spin') {
          if (wallet < currentBet) {
            await i.reply({
              content: `❌ У вас недостаточно денег для этой ставки! Ваш баланс: **${fmt(wallet)} ₪**`,
              ephemeral: true,
            });
            return;
          }

          // Блокируем кнопки на время спина
          await i.update({
            components: [getSlotsButtons(true)],
            embeds: [buildEmbed([], 'spinning')],
          });

          // Проводим транзакцию спина
          const result = await withFinancialLock(guildId, userId, async () => {
            const db = getDatabase();
            try {
              const spinResult = await db.$transaction(async (tx) => {
                const configRow = await tx.economyConfig.findUnique({ where: { guildId } });
                if (!configRow) throw new Error('config_not_found');
                // Все спины одной гильдии сериализуются на строке jackpot. Это
                // исключает две выплаты одного и того же накопленного банка.
                await tx.$queryRaw`SELECT "id" FROM "economy_configs" WHERE "id" = ${configRow.id} FOR UPDATE`;
                const freshConfig = await tx.economyConfig.findUniqueOrThrow({ where: { id: configRow.id } });
                const currentJackpot = freshConfig.slotsJackpot ?? CASINO_DEFAULTS.slotsJackpotSeed;
                const reels = spinSlots();
                const { multiplier, type } = getMultiplier(reels);

                if (type === 'jackpot') {
                  const winAmount = currentJackpot;
                  const net = winAmount - currentBet;
                  const player = await applyWalletDeltaInTransaction(
                    tx, guildId, userId, net, TX.CASINO_WIN, `Slots: ${reels.join(' ')} (JACKPOT!)`, undefined,
                    { allowDirtySpend: false },
                  );
                  await tx.economyConfig.update({
                    where: { id: freshConfig.id },
                    data: { slotsJackpot: CASINO_DEFAULTS.slotsJackpotSeed },
                  });
                  return {
                    reels, type, won: true, net, wallet: player.wallet, multiplier,
                    jackpotWon: true, winAmount, finalJackpot: CASINO_DEFAULTS.slotsJackpotSeed,
                  };
                }

                const jackpotInc = Math.max(1, Math.floor(currentBet * CASINO_DEFAULTS.slotsJackpotPercent));
                const updatedConfig = await tx.economyConfig.update({
                  where: { id: freshConfig.id },
                  data: { slotsJackpot: { increment: jackpotInc } },
                });

                if (multiplier === 0) {
                  const player = await applyWalletDeltaInTransaction(
                    tx, guildId, userId, -currentBet, TX.CASINO_LOSE, `Slots: ${reels.join(' ')}`, undefined,
                    { allowDirtySpend: false },
                  );
                  await applyWalletDeltaInTransaction(
                    tx, guildId, 'government', currentBet, 'slots_income',
                    `Доход от слотов с игрока ${userId}`, userId,
                  );
                  return { reels, type, won: false, net: -currentBet, wallet: player.wallet, finalJackpot: updatedConfig.slotsJackpot };
                }

                const winAmount = Math.floor(currentBet * multiplier);
                const net = winAmount - currentBet;
                const player = await applyWalletDeltaInTransaction(
                  tx, guildId, userId, net, TX.CASINO_WIN, `Slots: ${reels.join(' ')} (x${multiplier})`, undefined,
                  { allowDirtySpend: false },
                );
                return { reels, type, won: true, net, wallet: player.wallet, multiplier, finalJackpot: updatedConfig.slotsJackpot };
              });
              await invalidateProfileCache(guildId, userId);
              await invalidateConfigCache(guildId);
              return spinResult;
            } catch (err: any) {
              if (err?.message === 'insufficient_funds' || err?.message === 'dirty_blocked') return { error: 'no_money' as const };
              throw err;
            }
          });

          if (result === null || 'error' in result) {
            // Разблокируем кнопки и выводим ошибку
            await interaction.editReply({
              embeds: [ecoError(i18n.t('economy.common.error_no_money', locale))],
              components: [getSlotsButtons(false)],
            });
            return;
          }

          // Анимация прокрутки:
          // Шаг 1: первый остановился
          await new Promise((r) => setTimeout(r, 800));
          await interaction.editReply({
            embeds: [buildEmbed(result.reels, 'stop1')],
          });

          // Шаг 2: второй остановился
          await new Promise((r) => setTimeout(r, 800));
          await interaction.editReply({
            embeds: [buildEmbed(result.reels, 'stop2')],
          });

          // Шаг 3: финал
          await new Promise((r) => setTimeout(r, 800));

          // Обновляем локальные переменные для отображения на панели
          wallet = result.wallet;
          jackpot = result.finalJackpot;

          await interaction.editReply({
            embeds: [buildEmbed(result.reels, 'result', result.net, result.won, result.type, result.multiplier)],
            components: [getSlotsButtons(false)], // Разблокируем кнопки
          });

          // Публикуем новости в фоне
          if (result.won) {
            if (result.type === 'jackpot' && 'winAmount' in result) {
              await newsSlotsProgressiveJackpot(client, guildId, userId, result.winAmount!, locale).catch(() => {});
            } else {
              await newsCasinoWin(client, guildId, userId, 'slots', currentBet, result.net, locale).catch(() => {});
            }
          }
        }
      } catch (err) {
        log.error('Ошибка обработки кнопки автомата слотов', err);
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'module_unload' || !canProcessEconomyCollector(guildId)) return;
      try {
        const isRu = locale === 'ru';
        const authorName = isRu
          ? `🎰 Кошерный Слот EREZ | Игрок: ${interaction.user.displayName}`
          : `🎰 Kosher Slot EREZ | Player: ${interaction.user.displayName}`;

        const closedEmbed = new BublikEmbed()
          .setColor(0x7f8c8d)
          .setAuthor({
            name: authorName,
            iconURL: interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setDescription(
            `🎰 **[ 🍒 | 🍋 | 💎 ]**\n\n` +
            `🛑 **Игровой сеанс завершен**\n` +
            `*${reason === 'user_quit' ? (isRu ? 'Вы вышли из игры.' : 'You left the game.') : (isRu ? 'Сессия закрыта из-за бездействия.' : 'Session closed due to inactivity.')}*`,
          );

        // Отключаем кнопки навсегда
        await interaction.editReply({
          embeds: [closedEmbed],
          components: [getSlotsButtons(true)],
        }).catch(() => null);
      } catch { /* ignore */ }
    });
  },
};

export default slotsCommand;
