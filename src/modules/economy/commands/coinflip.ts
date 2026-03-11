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
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX, CURRENCY } from '../constants';

const log = logger.child('Economy:Coinflip');

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

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError('Экономика отключена.')], ephemeral: true });
      return;
    }
    if (config.casinoEnabled === false) {
      await interaction.reply({ embeds: [ecoError('Казино отключено на этом сервере.')], ephemeral: true });
      return;
    }

    const minBet = config.casinoMinBet ?? CASINO_DEFAULTS.minBet;
    const maxBet = config.casinoMaxBet ?? CASINO_DEFAULTS.maxBet;

    if (bet < minBet || bet > maxBet) {
      await interaction.reply({
        embeds: [ecoError(`Ставка: от ${fmt(minBet)} до ${fmt(maxBet)}.`)],
        ephemeral: true,
      });
      return;
    }

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);
      if (profile.wallet < bet) return { error: 'no_money' as const };

      const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
      const won = side === outcome;
      const winAmount = Math.floor(bet * CASINO_DEFAULTS.coinflipMultiplier);

      if (won) {
        const r = await addToWallet(guildId, userId, winAmount - bet, TX.CASINO_WIN, `Coinflip: угадал ${side}`);
        return { won: true, outcome, amount: winAmount - bet, wallet: r.wallet };
      } else {
        const r = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, `Coinflip: не угадал (было ${outcome})`);
        return { won: false, outcome, amount: bet, wallet: r.wallet };
      }
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if ('error' in result) {
      await interaction.reply({ embeds: [ecoError('Недостаточно шекелей в кошельке.')], ephemeral: true });
      return;
    }

    const sideNames = { heads: '🦅 Орёл', tails: '🪙 Решка' };

    const embed = new BublikEmbed()
      .setColor(result.won ? 0x2ecc71 : 0xe74c3c)
      .setAuthor({
        name: `${interaction.user.displayName} — Монетка`,
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `${EMOJI.COIN} Монетка крутится...\n\n` +
        `Выпало: **${sideNames[result.outcome as 'heads' | 'tails']}**\n` +
        `Ваш выбор: **${sideNames[side]}**\n\n` +
        (result.won
          ? `${EMOJI.SUCCESS} **Победа!** Вы выиграли **${fmt(result.amount)}**`
          : `${EMOJI.ERROR} **Проигрыш.** Вы потеряли **${fmt(result.amount)}**`) +
        `\n\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default coinflipCommand;
