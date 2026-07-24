// ═══════════════════════════════════════════════
//  /dice — Кости
//
//  Бросаете кости (1-6). Три режима:
//  • exact  — угадать точное число (x2.5)
//  • higher — выпадет ≥ загаданного (x1.5)
//  • lower  — выпадет ≤ загаданного (x1.5)
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX } from '../constants';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { newsCasinoWin } from '../news';
import { secureRandomInt } from '../random';

/**
 * Динамический множитель для range-режимов на основе вероятности.
 * higher N: prob = (7-N)/6, payout = 0.95 / prob (5% house edge)
 * lower  N: prob = N/6,     payout = 0.95 / prob
 *
 * Результаты:
 *   higher 2 / lower 5: x1.1   (prob 83%)
 *   higher 3 / lower 4: x1.4   (prob 67%)
 *   higher 4 / lower 3: x1.9   (prob 50%)
 *   higher 5 / lower 2: x2.9   (prob 33%)
 *   higher 6 / lower 1: x5.7   (prob 17%)
 */
function getDiceRangeMultiplier(mode: 'higher' | 'lower', guess: number): number {
  const prob = mode === 'higher' ? (7 - guess) / 6 : guess / 6;
  if (prob <= 0 || prob >= 1) return 0; // safety — trivial picks blocked earlier
  return Math.round((0.95 / prob) * 10) / 10;
}

const diceCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Бросить кости — угадайте число!')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Режим')
        .setRequired(true)
        .addChoices(
          { name: '🎯 Точное число (x2.5)', value: 'exact' },
          { name: '⬆️ Больше или равно (x1.5)', value: 'higher' },
          { name: '⬇️ Меньше или равно (x1.5)', value: 'lower' },
        ),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('number')
        .setDescription('Число (1-6)')
        .setMinValue(1)
        .setMaxValue(6)
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('bet')
        .setDescription('Ставка (₪)')
        .setMinValue(1)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.dice.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const mode = interaction.options.getString('mode', true) as 'exact' | 'higher' | 'lower';
    const guess = interaction.options.getInteger('number', true);
    const bet = interaction.options.getInteger('bet', true);
    const locale = await getGuildLocale(interaction.guildId);

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

    if (bet < minBet || bet > maxBet) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.common.error_bet_range', locale, { min: fmt(minBet), max: fmt(maxBet) }))],
        ephemeral: true,
      });
      return;
    }

    // Блокируем тривиальные ставки (100% шанс выигрыша)
    if (mode === 'higher' && guess <= 1) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.dice.error_higher_trivial', locale))],
        ephemeral: true,
      });
      return;
    }
    if (mode === 'lower' && guess >= 6) {
      await interaction.reply({
        embeds: [ecoError(i18n.t('economy.cmd.dice.error_lower_trivial', locale))],
        ephemeral: true,
      });
      return;
    }

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);
      if (profile.wallet < bet) return { error: 'no_money' as const };

      const roll = secureRandomInt(1, 6);
      let won = false;

      switch (mode) {
        case 'exact':  won = roll === guess; break;
        case 'higher': won = roll >= guess; break;
        case 'lower':  won = roll <= guess; break;
      }

      const multi = mode === 'exact'
        ? CASINO_DEFAULTS.diceMultiplier
        : getDiceRangeMultiplier(mode, guess);

      if (won) {
        const winAmount = Math.floor(bet * multi);
        const net = winAmount - bet;
        const r = await addToWallet(guildId, userId, net, TX.CASINO_WIN, `Dice: ${roll} (${mode} ${guess}, x${multi})`, undefined, { allowDirtySpend: false });
        if (!r.success) return { error: 'no_money' as const };
        return { won: true, roll, net, wallet: r.wallet, multi };
      } else {
        const r = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, `Dice: ${roll} (${mode} ${guess})`, undefined, { allowDirtySpend: false });
        if (!r.success) return { error: 'no_money' as const };
        await addToWallet(guildId, 'government', bet, 'dice_income', `Доход от костей с игрока ${userId}`).catch(() => null);
        return { won: false, roll, net: -bet, wallet: r.wallet, multi };
      }
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }
    if ('error' in result) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_no_money', locale))], ephemeral: true });
      return;
    }

    const modeNames = { exact: i18n.t('economy.cmd.dice.mode_exact', locale), higher: i18n.t('economy.cmd.dice.mode_higher', locale), lower: i18n.t('economy.cmd.dice.mode_lower', locale) };
    const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

    const embed = new BublikEmbed()
      .setColor(result.won ? 0x2ecc71 : 0xe74c3c)
      .setAuthor({
        name: i18n.t('economy.cmd.dice.embed_author', locale, { user: interaction.user.displayName }),
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `${EMOJI.DICE} ${i18n.t('economy.cmd.dice.embed_rolled', locale, { dice: diceEmojis[result.roll], number: result.roll })}\n` +
        `${i18n.t('economy.cmd.dice.embed_your_bet', locale, { mode: modeNames[mode], number: guess })}\n\n` +
        (result.won
          ? `${EMOJI.SUCCESS} ${i18n.t('economy.cmd.dice.embed_win', locale, { multi: result.multi, amount: fmt(result.net) })}`
          : `${EMOJI.ERROR} ${i18n.t('economy.cmd.dice.embed_lose', locale, { amount: fmt(Math.abs(result.net)) })}`) +
        `\n\n${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
      );

    await interaction.reply({ embeds: [embed] });

    // Новости: крупный выигрыш
    if (result.won) {
      await newsCasinoWin(client, guildId, userId, 'dice', bet, result.net, locale).catch(() => {});
    }
  },
};

export default diceCommand;
