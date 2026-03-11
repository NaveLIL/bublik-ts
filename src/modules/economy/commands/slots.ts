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
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX } from '../constants';

const log = logger.child('Economy:Slots');

const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '💎', '7️⃣', '💰'];

function spinSlots(): [string, string, string] {
  return [
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
  ];
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

const slotsCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('Слот-машина — крутите барабаны!')
    .addIntegerOption((opt) =>
      opt
        .setName('bet')
        .setDescription('Ставка (₪)')
        .setMinValue(1)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.slots.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
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

      const reels = spinSlots();
      const { multiplier, type } = getMultiplier(reels);

      if (multiplier === 0) {
        const r = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, `Slots: ${reels.join(' ')}`);
        return { reels, type, won: false, net: -bet, wallet: r.wallet };
      }

      const winAmount = Math.floor(bet * multiplier);
      const net = winAmount - bet;
      const r = await addToWallet(guildId, userId, net, TX.CASINO_WIN, `Slots: ${reels.join(' ')} (x${multiplier})`);
      return { reels, type, won: true, net, wallet: r.wallet, multiplier };
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if ('error' in result) {
      await interaction.reply({ embeds: [ecoError('Недостаточно шекелей в кошельке.')], ephemeral: true });
      return;
    }

    const typeNames: Record<string, string> = {
      jackpot: '🎉 ДЖЕКПОТ!!!',
      triple: '✨ Тройка!',
      double: '👍 Пара!',
      lose: '💨 Мимо...',
    };

    const embed = new BublikEmbed()
      .setColor(result.type === 'jackpot' ? 0xf1c40f : result.won ? 0x2ecc71 : 0xe74c3c)
      .setAuthor({
        name: `${interaction.user.displayName} — Слоты`,
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `${EMOJI.SLOTS} **[ ${result.reels.join(' | ')} ]**\n\n` +
        `${typeNames[result.type]}` +
        (result.won
          ? ` **x${result.multiplier}** → **+${fmt(result.net)}**`
          : ` Вы потеряли **${fmt(Math.abs(result.net))}**`) +
        `\n\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default slotsCommand;
