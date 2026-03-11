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
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX } from '../constants';

const log = logger.child('Economy:Dice');

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

      const roll = Math.floor(Math.random() * 6) + 1;
      let won = false;

      switch (mode) {
        case 'exact':  won = roll === guess; break;
        case 'higher': won = roll >= guess; break;
        case 'lower':  won = roll <= guess; break;
      }

      const multi = mode === 'exact' ? CASINO_DEFAULTS.diceMultiplier : CASINO_DEFAULTS.diceRangeMultiplier;

      if (won) {
        const winAmount = Math.floor(bet * multi);
        const net = winAmount - bet;
        const r = await addToWallet(guildId, userId, net, TX.CASINO_WIN, `Dice: ${roll} (${mode} ${guess}, x${multi})`);
        return { won: true, roll, net, wallet: r.wallet, multi };
      } else {
        const r = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, `Dice: ${roll} (${mode} ${guess})`);
        return { won: false, roll, net: -bet, wallet: r.wallet, multi };
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

    const modeNames = { exact: 'Точно', higher: '≥', lower: '≤' };
    const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

    const embed = new BublikEmbed()
      .setColor(result.won ? 0x2ecc71 : 0xe74c3c)
      .setAuthor({
        name: `${interaction.user.displayName} — Кости`,
        iconURL: interaction.user.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `${EMOJI.DICE} Выпало: **${diceEmojis[result.roll]} (${result.roll})**\n` +
        `Ваша ставка: **${modeNames[mode]} ${guess}**\n\n` +
        (result.won
          ? `${EMOJI.SUCCESS} **Победа!** x${result.multi} → **+${fmt(result.net)}**`
          : `${EMOJI.ERROR} **Проигрыш.** −**${fmt(Math.abs(result.net))}**`) +
        `\n\n${EMOJI.WALLET} Кошелёк: **${fmt(result.wallet)}**`,
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default diceCommand;
