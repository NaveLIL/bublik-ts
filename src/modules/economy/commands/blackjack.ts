// ═══════════════════════════════════════════════
//  /blackjack — Блэкджек против дилера
//
//  Классический 21. Кнопки: Hit / Stand / Double.
//  • Блэкджек (21 с 2 карт) = x2.5
//  • Победа = x2.0
//  • Ничья = возврат ставки
//  • Bust / проигрыш = потеря ставки
//  60с таймаут → автоматический stand.
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Message,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { addToWallet, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX, ECO_PREFIX, ECO_SEP } from '../constants';

const log = logger.child('Economy:Blackjack');

// ── Карты ────────────────────────────────────

interface Card { suit: string; rank: string; value: number }

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      let value: number;
      if (rank === 'A') value = 11;
      else if (['J', 'Q', 'K'].includes(rank)) value = 10;
      else value = parseInt(rank, 10);
      deck.push({ suit, rank, value });
    }
  }
  // Shuffle (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += c.value;
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function formatHand(hand: Card[], hideSecond = false): string {
  if (hideSecond && hand.length >= 2) {
    return `${hand[0].rank}${hand[0].suit} | ❓`;
  }
  return hand.map((c) => `${c.rank}${c.suit}`).join(' | ');
}

function isBlackjack(hand: Card[]): boolean {
  return hand.length === 2 && handValue(hand) === 21;
}

// ── Команда ──────────────────────────────────

const blackjackCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Блэкджек — соберите 21!')
    .addIntegerOption((opt) =>
      opt
        .setName('bet')
        .setDescription('Ставка (₪)')
        .setMinValue(1)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.blackjack.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    let bet = interaction.options.getInteger('bet', true);

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

    // Проверяем баланс и списываем ставку
    const deductResult = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);
      if (profile.wallet < bet) return { error: 'no_money' as const };
      const walletResult = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, 'BJ: ставка');
      if (!walletResult.success) return { error: 'no_money' as const };
      return { wallet: walletResult.wallet };
    });

    if (deductResult === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if ('error' in deductResult) {
      await interaction.reply({ embeds: [ecoError('Недостаточно шекелей.')], ephemeral: true });
      return;
    }

    // Раздаём карты
    const deck = newDeck();
    const playerHand: Card[] = [deck.pop()!, deck.pop()!];
    const dealerHand: Card[] = [deck.pop()!, deck.pop()!];

    let doubled = false;
    const sessionId = `${ECO_PREFIX}${ECO_SEP}bj${ECO_SEP}${userId}${ECO_SEP}${Date.now()}`;

    // Проверяем мгновенный блэкджек
    if (isBlackjack(playerHand)) {
      const winAmount = Math.floor(bet * CASINO_DEFAULTS.blackjackBjMultiplier);
      await addToWallet(guildId, userId, winAmount, TX.CASINO_BJ, 'BJ: Блэкджек!');

      const embed = buildGameEmbed(interaction, playerHand, dealerHand, false, winAmount - bet, 'blackjack');
      await interaction.reply({ embeds: [embed] });
      return;
    }

    // Показываем стол с кнопками
    const msg = await interaction.reply({
      embeds: [buildGameEmbed(interaction, playerHand, dealerHand, true, 0, 'playing')],
      components: [buildButtons(sessionId, deductResult.wallet >= bet)],
      fetchReply: true,
    });

    // Собираем кнопки (60с таймаут)
    const collector = (msg as Message).createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === userId && i.customId.startsWith(sessionId),
      time: 60_000,
    });

    collector.on('collect', async (btnInteraction) => {
      const action = btnInteraction.customId.split(ECO_SEP).pop();

      if (action === 'hit' || action === 'double') {
        if (action === 'double') {
          // Списываем доп. ставку
          const doubleResult = await withFinancialLock(guildId, userId, async () => {
            const p = await getOrCreateProfile(guildId, userId);
            if (p.wallet < bet) return null;
            const walletResult = await addToWallet(guildId, userId, -bet, TX.CASINO_LOSE, 'BJ: double');
            if (!walletResult.success) return null;
            return true;
          });

          if (!doubleResult) {
            await btnInteraction.reply({ embeds: [ecoError('Недостаточно для удвоения.')], ephemeral: true });
            return;
          }

          bet *= 2;
          doubled = true;
        }

        playerHand.push(deck.pop()!);
        const pVal = handValue(playerHand);

        if (pVal > 21 || doubled) {
          collector.stop(pVal > 21 ? 'bust' : 'doubled');
          if (pVal > 21) {
            // Bust — ставка уже списана
            await btnInteraction.update({
              embeds: [buildGameEmbed(interaction, playerHand, dealerHand, false, -bet, 'bust')],
              components: [],
            });
          } else {
            // Double → стоим автоматически
            const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, bet);
            await btnInteraction.update({
              embeds: [buildGameEmbed(interaction, playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
              components: [],
            });
          }
          return;
        }

        await btnInteraction.update({
          embeds: [buildGameEmbed(interaction, playerHand, dealerHand, true, 0, 'playing')],
          components: [buildButtons(sessionId, !doubled && deductResult.wallet >= bet * 2)],
        });
      } else if (action === 'stand') {
        collector.stop('stand');
        const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, bet);
        await btnInteraction.update({
          embeds: [buildGameEmbed(interaction, playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
          components: [],
        });
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        // Таймаут → stand
        const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, bet);
        await (msg as Message).edit({
          embeds: [buildGameEmbed(interaction, playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
          components: [],
        }).catch(() => {});
      }
    });
  },
};

// ── Дилер играет + выплата ───────────────────

async function resolveDealerAndPay(
  deck: Card[],
  dealerHand: Card[],
  playerHand: Card[],
  guildId: string,
  userId: string,
  bet: number,
): Promise<{ net: number; outcome: string }> {
  // Дилер тянет до ≥17
  while (handValue(dealerHand) < 17) {
    dealerHand.push(deck.pop()!);
  }

  const pVal = handValue(playerHand);
  const dVal = handValue(dealerHand);

  if (dVal > 21 || pVal > dVal) {
    // Победа
    const winAmount = Math.floor(bet * CASINO_DEFAULTS.blackjackMultiplier);
    await addToWallet(guildId, userId, winAmount, TX.CASINO_WIN, `BJ: ${pVal} vs ${dVal}`);
    return { net: winAmount - bet, outcome: 'win' };
  } else if (pVal === dVal) {
    // Ничья — возврат ставки
    await addToWallet(guildId, userId, bet, TX.CASINO_WIN, `BJ: push ${pVal}`);
    return { net: 0, outcome: 'push' };
  } else {
    // Проигрыш — ставка уже списана
    return { net: -bet, outcome: 'lose' };
  }
}

// ── UI ───────────────────────────────────────

function buildButtons(sessionId: string, canDouble: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${sessionId}${ECO_SEP}hit`)
      .setLabel('Ещё')
      .setEmoji('🃏')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${sessionId}${ECO_SEP}stand`)
      .setLabel('Стоп')
      .setEmoji('✋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${sessionId}${ECO_SEP}double`)
      .setLabel('Удвоить')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canDouble),
  );
}

function buildGameEmbed(
  interaction: ChatInputCommandInteraction,
  player: Card[],
  dealer: Card[],
  hideDealer: boolean,
  net: number,
  outcome: string,
): BublikEmbed {
  const pVal = handValue(player);
  const dVal = hideDealer ? '?' : handValue(dealer);

  const outcomeText: Record<string, string> = {
    playing: `${EMOJI.CARDS} *Ваш ход...*`,
    blackjack: `${EMOJI.CROWN} **БЛЭКДЖЕК!** +**${fmt(net)}**`,
    win: `${EMOJI.SUCCESS} **Победа!** +**${fmt(net)}**`,
    lose: `${EMOJI.ERROR} **Проигрыш.** −**${fmt(Math.abs(net))}**`,
    bust: `${EMOJI.ERROR} **Перебор!** −**${fmt(Math.abs(net))}**`,
    push: `${EMOJI.ARROW_RIGHT} **Ничья.** Ставка возвращена.`,
  };

  return new BublikEmbed()
    .setColor(
      outcome === 'playing' ? 0x3498db :
      outcome === 'blackjack' ? 0xf1c40f :
      ['win', 'push'].includes(outcome) ? 0x2ecc71 : 0xe74c3c,
    )
    .setAuthor({
      name: `${interaction.user.displayName} — Блэкджек`,
      iconURL: interaction.user.displayAvatarURL({ size: 64 }),
    })
    .setDescription(
      `**Дилер** [${dVal}]: ${formatHand(dealer, hideDealer)}\n` +
      `**Вы** [${pVal}]: ${formatHand(player)}\n\n` +
      (outcomeText[outcome] || ''),
    );
}

export default blackjackCommand;
