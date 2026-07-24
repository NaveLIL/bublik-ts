// ═══════════════════════════════════════════════
//  /coinflip — Подбрасывание монетки
//
//  Угадай орёл или решку. x1.9 при победе.
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
import { secureRandomFloat } from '../random';

const coinflipCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Подбросить монетку — орёл или решка')
    .addStringOption((opt) =>
      opt
        .setName('side')
        .setDescription('Ваш выбор')
        .setRequired(true)
        .addChoices(
          { name: '🦅 Орёл', value: 'heads' },
          { name: '🪙 Решка', value: 'tails' },
        ),
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
  descriptionKey: 'commands.coinflip.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const side = interaction.options.getString('side', true) as 'heads' | 'tails';
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

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);
      if (profile.wallet < bet) return { error: 'no_money' as const };

      const outcome = secureRandomFloat() < 0.5 ? 'heads' : 'tails';
      const won = side === outcome;
      const winAmount = Math.floor(bet * CASINO_DEFAULTS.coinflipMultiplier);

      if (won) {
        const r = await addToWallet(guildId, userId, winAmount - bet, TX.CASINO_WIN, i18n.t('economy.cmd.coinflip.tx_win', locale, { side }), undefined, { allowDirtySpend: false });
        if (!r.success) return { error: 'no_money' as const };
        return { won: true, outcome, amount: winAmount - bet, wallet: r.wallet };
      } else {
        const r = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, i18n.t('economy.cmd.coinflip.tx_lose', locale, { outcome }), undefined, { allowDirtySpend: false });
        if (!r.success) return { error: 'no_money' as const };
        await addToWallet(guildId, 'government', bet, 'coinflip_income', `Доход от коинфлипа с игрока ${userId}`).catch(() => null);
        return { won: false, outcome, amount: bet, wallet: r.wallet };
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

    const sideNames = { heads: i18n.t('economy.cmd.coinflip.choice_heads', locale), tails: i18n.t('economy.cmd.coinflip.choice_tails', locale) };

    const embed = new BublikEmbed()
      .setColor(result.won ? 0x2ecc71 : 0xe74c3c)
      .setAuthor({
        name: i18n.t('economy.cmd.coinflip.embed_author', locale, { user: interaction.user.displayName }),
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `${EMOJI.COIN} ${i18n.t('economy.cmd.coinflip.embed_spinning', locale)}\n\n` +
        `${i18n.t('economy.cmd.coinflip.embed_result', locale, { side: sideNames[result.outcome as 'heads' | 'tails'] })}\n` +
        `${i18n.t('economy.cmd.coinflip.embed_your_choice', locale, { side: sideNames[side] })}\n\n` +
        (result.won
          ? `${EMOJI.SUCCESS} ${i18n.t('economy.cmd.coinflip.embed_win', locale, { amount: fmt(result.amount) })}`
          : `${EMOJI.ERROR} ${i18n.t('economy.cmd.coinflip.embed_lose', locale, { amount: fmt(result.amount) })}`) +
        `\n\n${EMOJI.WALLET} ${i18n.t('economy.common.embed_wallet', locale, { amount: fmt(result.wallet) })}`,
      );

    await interaction.reply({ embeds: [embed] });

    // Новости: крупный выигрыш
    if (result.won) {
      await newsCasinoWin(client, guildId, userId, 'coinflip', bet, result.amount, locale).catch(() => {});
    }
  },
};

export default coinflipCommand;
