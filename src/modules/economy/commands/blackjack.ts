// ═══════════════════════════════════════════════
//  /blackjack — Блэкджек против дилера (Интерактивный стол)
//
//  Классический 21 с многоразовой панелью ставок.
//  • Блэкджек (21 с 2 карт) = x2.5
//  • Победа = x2.0
//  • Ничья = возврат ставки
//  • Bust / проигрыш = потеря ставки
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile, invalidateProfileCache } from '../database';
import { applyWalletDeltaInTransaction, claimOperationInTransaction, withFinancialLock, fmt } from '../profile';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError } from '../embeds';
import { CASINO_DEFAULTS, EMOJI, TX } from '../constants';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getRedis } from '../../../core/Redis';
import { getDatabase } from '../../../core/Database';
import { isGuildAllowed } from '../../../core/Whitelist';
import { newsCasinoWin } from '../news';
import { getOnceOnlySettlementEffects } from '../safety-policy';
import { secureRandomInt } from '../random';
import { canProcessEconomyCollector, registerEconomyCollector } from '../collector-lifecycle';

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
    const j = secureRandomInt(0, i);
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

function pendingBjKey(guildId: string, userId: string): string {
  return `eco:bj:pending:${guildId}:${userId}`;
}

const BJ_SESSION_TTL_MS = 10 * 60_000;
const BJ_STALE_AFTER_MS = 120_000;
const BJ_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface BlackjackSessionMetadata {
  totalBet: number;
  state: 'open' | 'settled' | 'refunded';
}

function blackjackSessionKey(guildId: string, userId: string, sessionId: string): string {
  return `blackjack-session:${guildId}:${userId}:${sessionId}`;
}

function blackjackSettlementKey(guildId: string, userId: string, sessionId: string): string {
  return `blackjack-settlement:${guildId}:${userId}:${sessionId}`;
}

function parseSessionMetadata(value: unknown): BlackjackSessionMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.totalBet) || Number(raw.totalBet) <= 0) return null;
  const state = raw.state;
  if (state !== 'open' && state !== 'settled' && state !== 'refunded') return null;
  return { totalBet: Number(raw.totalBet), state };
}

async function beginBlackjackSession(
  guildId: string,
  userId: string,
  sessionId: string,
  bet: number,
): Promise<{ wallet: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const updated = await applyWalletDeltaInTransaction(
      tx, guildId, userId, -bet, TX.CASINO_LOSE, `BJ stake ${sessionId}`, undefined,
      { allowDirtySpend: false },
    );
    await tx.operationClaim.create({
      data: {
        key: blackjackSessionKey(guildId, userId, sessionId),
        scope: 'blackjack_session',
        guildId,
        userId,
        metadata: { totalBet: bet, state: 'open' },
        expiresAt: new Date(Date.now() + BJ_SESSION_TTL_MS),
      },
    });
    return { wallet: updated.wallet };
  });
  await invalidateProfileCache(guildId, userId);
  return result;
}

async function doubleBlackjackSession(
  guildId: string,
  userId: string,
  sessionId: string,
  additionalBet: number,
): Promise<{ wallet: number; totalBet: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const session = await tx.operationClaim.findUnique({
      where: { key: blackjackSessionKey(guildId, userId, sessionId) },
    });
    const metadata = parseSessionMetadata(session?.metadata);
    if (!session || !metadata || metadata.state !== 'open' || (session.expiresAt?.getTime() ?? 0) <= Date.now()) {
      throw new Error('session_not_open');
    }

    const updated = await applyWalletDeltaInTransaction(
      tx, guildId, userId, -additionalBet, TX.CASINO_LOSE, `BJ double ${sessionId}`, undefined,
      { allowDirtySpend: false },
    );
    const totalBet = metadata.totalBet + additionalBet;
    await tx.operationClaim.update({
      where: { key: session.key },
      data: { metadata: { totalBet, state: 'open' } },
    });
    return { wallet: updated.wallet, totalBet };
  });
  await invalidateProfileCache(guildId, userId);
  return result;
}

async function settleBlackjackSession(
  guildId: string,
  userId: string,
  sessionId: string,
  payout: number,
  governmentIncome: number,
  txType: string,
  details: string,
  finalState: 'settled' | 'refunded' = 'settled',
): Promise<{ claimed: boolean; wallet: number; totalBet: number }> {
  const db = getDatabase();
  const result = await db.$transaction(async (tx) => {
    const session = await tx.operationClaim.findUnique({
      where: { key: blackjackSessionKey(guildId, userId, sessionId) },
    });
    const metadata = parseSessionMetadata(session?.metadata);
    if (!session || !metadata) throw new Error('session_not_found');

    const claimed = await claimOperationInTransaction(
      tx,
      blackjackSettlementKey(guildId, userId, sessionId),
      'blackjack_settlement',
      guildId,
      userId,
      { payout, governmentIncome, finalState },
      new Date(Date.now() + BJ_CLAIM_RETENTION_MS),
    );
    const effects = getOnceOnlySettlementEffects(claimed, payout, governmentIncome);
    if (!claimed) {
      const profile = await tx.economyProfile.findUniqueOrThrow({
        where: { guildId_userId: { guildId, userId } },
      });
      return { claimed: false, wallet: profile.wallet, totalBet: metadata.totalBet };
    }

    let wallet: number;
    if (effects.walletCredit > 0) {
      const updated = await applyWalletDeltaInTransaction(
        tx, guildId, userId, effects.walletCredit, txType, details,
      );
      wallet = updated.wallet;
    } else {
      const profile = await tx.economyProfile.findUniqueOrThrow({
        where: { guildId_userId: { guildId, userId } },
      });
      wallet = profile.wallet;
    }

    if (effects.governmentCredit > 0) {
      await applyWalletDeltaInTransaction(
        tx,
        guildId,
        'government',
        effects.governmentCredit,
        'blackjack_income',
        `Доход от блэкджека с игрока ${userId}`,
        userId,
      );
    }

    await tx.operationClaim.update({
      where: { key: session.key },
      data: {
        metadata: { totalBet: metadata.totalBet, state: finalState },
        expiresAt: new Date(),
      },
    });
    return { claimed: true, wallet, totalBet: metadata.totalBet };
  });
  await invalidateProfileCache(guildId, userId);
  return result;
}

export async function recoverStaleBlackjackSessions(): Promise<number> {
  const db = getDatabase();
  const sessions = await db.operationClaim.findMany({
    where: {
      scope: 'blackjack_session',
      createdAt: { lte: new Date(Date.now() - BJ_STALE_AFTER_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  let refunded = 0;
  for (const session of sessions) {
    if (!session.guildId || !isGuildAllowed(session.guildId)) continue;
    const metadata = parseSessionMetadata(session.metadata);
    if (!session.guildId || !session.userId || !metadata || metadata.state !== 'open') continue;
    const sessionId = session.key.split(':').pop();
    if (!sessionId) continue;
    try {
      const result = await settleBlackjackSession(
        session.guildId,
        session.userId,
        sessionId,
        metadata.totalBet,
        0,
        TX.CASINO_WIN,
        'BJ: stale session refund',
        'refunded',
      );
      if (result.claimed) refunded++;
    } catch (error) {
      log.error(`Не удалось вернуть зависшую ставку BJ ${session.key}`, error);
    }
  }
  return refunded;
}

function getBetStep(bet: number): number {
  if (bet < 1000) return 100;
  if (bet < 10000) return 1000;
  return 5000;
}

// ── Кнопки ───────────────────────────────────

function getBetButtons(disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('bet_minus')
      .setLabel('➖')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('deal')
      .setLabel('🃏 Раздать')
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

function getGameButtons(canDouble: boolean, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('hit')
      .setLabel('🃏 Ещё')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('stand')
      .setLabel('✋ Стоп')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('double')
      .setLabel('💰 Удвоить')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canDouble || disabled),
  );
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
        .setRequired(false),
    ) as SlashCommandBuilder,

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.blackjack.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
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

    // Начальная ставка
    let currentBet = interaction.options.getInteger('bet') ?? minBet;
    if (currentBet < minBet) currentBet = minBet;
    if (currentBet > maxBet) currentBet = maxBet;

    // Восстановление застрявшей партии выполняется по durable session в БД,
    // а Redis используется только как быстрый UX-lock.
    const redis = getRedis();
    const pKey = pendingBjKey(guildId, userId);
    const db = getDatabase();
    const openSessions = await db.operationClaim.findMany({
      where: {
        scope: 'blackjack_session',
        guildId,
        userId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const session of openSessions) {
      const metadata = parseSessionMetadata(session.metadata);
      if (!metadata || metadata.state !== 'open') continue;
      const sessionId = session.key.split(':').pop()!;
      if (Date.now() - session.createdAt.getTime() > BJ_STALE_AFTER_MS) {
        await settleBlackjackSession(
          guildId,
          userId,
          sessionId,
          metadata.totalBet,
          0,
          TX.CASINO_WIN,
          'BJ: stale session refund',
          'refunded',
        ).catch((err) => log.error('Не удалось вернуть зависшую ставку BJ', err));
      }
    }

    const activeSession = await db.operationClaim.findFirst({
      where: {
        scope: 'blackjack_session',
        guildId,
        userId,
        expiresAt: { gt: new Date() },
      },
    });
    if (activeSession && parseSessionMetadata(activeSession.metadata)?.state === 'open') {
      await interaction.reply({
        embeds: [ecoError('У вас уже есть активная партия. Подождите до двух минут — зависшая ставка будет возвращена автоматически.')],
        ephemeral: true,
      });
      return;
    }
    await redis.del(pKey).catch(() => null);

    // Получаем текущие данные профиля
    let profile = await getOrCreateProfile(guildId, userId);
    let wallet = profile.wallet;

    const buildEmbed = (
      pHand: Card[],
      dHand: Card[],
      hideDealer: boolean,
      netAmount: number,
      gameOutcome: string,
    ): BublikEmbed => {
      const pVal = pHand.length > 0 ? handValue(pHand) : 0;
      const dVal = dHand.length > 0 ? (hideDealer ? '?' : handValue(dHand)) : 0;

      const outcomeText: Record<string, string> = {
        idle: `ℹ️ *Выберите ставку кнопками ниже и нажмите **Раздать** для начала игры.*`,
        playing: `${EMOJI.CARDS} ${i18n.t('economy.cmd.blackjack.outcome_playing', locale)}`,
        blackjack: `${EMOJI.CROWN} ${i18n.t('economy.cmd.blackjack.outcome_blackjack', locale, { amount: fmt(netAmount) })}`,
        win: `${EMOJI.SUCCESS} ${i18n.t('economy.cmd.blackjack.outcome_win', locale, { amount: fmt(netAmount) })}`,
        lose: `${EMOJI.ERROR} ${i18n.t('economy.cmd.blackjack.outcome_lose', locale, { amount: fmt(Math.abs(netAmount)) })}`,
        bust: `${EMOJI.ERROR} ${i18n.t('economy.cmd.blackjack.outcome_bust', locale, { amount: fmt(Math.abs(netAmount)) })}`,
        push: `${EMOJI.ARROW_RIGHT} ${i18n.t('economy.cmd.blackjack.outcome_push', locale)}`,
      };

      const embed = new BublikEmbed()
        .setColor(
          gameOutcome === 'playing' ? 0x3498db :
          gameOutcome === 'blackjack' ? 0xf1c40f :
          ['win', 'push'].includes(gameOutcome) ? 0x2ecc71 :
          gameOutcome === 'idle' ? 0x95a5a6 : 0xe74c3c,
        )
        .setAuthor({
          name: i18n.t('economy.cmd.blackjack.embed_author', locale, { user: interaction.user.displayName }),
          iconURL: interaction.user.displayAvatarURL({ size: 64 }),
        });

      if (gameOutcome !== 'idle') {
        embed.setDescription(
          `${i18n.t('economy.cmd.blackjack.embed_dealer', locale, { value: dVal })} ${formatHand(dHand, hideDealer)}\n` +
          `${i18n.t('economy.cmd.blackjack.embed_player', locale, { value: pVal })} ${formatHand(pHand)}\n\n` +
          (outcomeText[gameOutcome] || '') +
          `\n\n💵 Ставка: **${fmt(currentBet)} ₪**` +
          `\n${EMOJI.WALLET} Баланс: **${fmt(wallet)} ₪**`
        );
      } else {
        embed.setDescription(
          outcomeText.idle +
          `\n\n💵 Текущая ставка: **${fmt(currentBet)} ₪**` +
          `\n${EMOJI.WALLET} Ваш баланс: **${fmt(wallet)} ₪**`
        );
      }

      return embed;
    };

    // Стартовый вывод
    const response = await interaction.reply({
      embeds: [buildEmbed([], [], false, 0, 'idle')],
      components: [getBetButtons(false)],
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      idle: 60_000, // 60с неактивности
    });
    registerEconomyCollector(collector);

    let playerHand: Card[] = [];
    let dealerHand: Card[] = [];
    let deck: Card[] = [];
    let doubled = false;
    let playingState: 'idle' | 'playing' = 'idle';
    let currentSessionId: string | null = null;
    let totalBet = 0;
    let actionInFlight = false;

    collector.on('collect', async (i) => {
      if (!canProcessEconomyCollector(guildId)) {
        collector.stop('guild_not_allowed');
        await i.reply({ content: '⛔ Этот сервер больше не авторизован.', ephemeral: true }).catch(() => {});
        return;
      }
      if (i.user.id !== userId) {
        await i.reply({
          content: '❌ Этот игровой стол занят другим игроком! Используйте `/blackjack`, чтобы открыть свой.',
          ephemeral: true,
        });
        return;
      }

      if (actionInFlight) {
        await i.reply({ content: '⏳ Предыдущий ход ещё обрабатывается.', ephemeral: true });
        return;
      }
      actionInFlight = true;

      collector.resetTimer();

      try {
        if (playingState === 'idle') {
          if (i.customId === 'quit') {
            await i.deferUpdate();
            collector.stop('user_quit');
            return;
          }

          // Обновляем баланс перед проверками ставок
          profile = await getOrCreateProfile(guildId, userId);
          wallet = profile.wallet;

          if (i.customId === 'bet_minus') {
            const step = getBetStep(currentBet);
            currentBet = Math.max(minBet, currentBet - step);
            await i.update({ embeds: [buildEmbed([], [], false, 0, 'idle')] });
            return;
          }

          if (i.customId === 'bet_plus') {
            const step = getBetStep(currentBet);
            currentBet = Math.min(maxBet, wallet, currentBet + step);
            if (currentBet < minBet) currentBet = minBet;
            await i.update({ embeds: [buildEmbed([], [], false, 0, 'idle')] });
            return;
          }

          if (i.customId === 'bet_max') {
            currentBet = Math.min(maxBet, wallet);
            if (currentBet < minBet) currentBet = minBet;
            await i.update({ embeds: [buildEmbed([], [], false, 0, 'idle')] });
            return;
          }

          if (i.customId === 'deal') {
            if (wallet < currentBet) {
              await i.reply({
                content: `❌ У вас недостаточно шекелей! Баланс: **${fmt(wallet)} ₪**`,
                ephemeral: true,
              });
              return;
            }

            const sessionId = randomUUID();
            const redisLock = await redis.set(
              pKey,
              JSON.stringify({ sessionId, createdAt: Date.now() }),
              'EX',
              Math.ceil(BJ_SESSION_TTL_MS / 1000),
              'NX',
            ).catch(() => null);
            if (redisLock !== 'OK') {
              await i.reply({ content: '❌ У вас уже есть активная партия или хранилище сессий недоступно.', ephemeral: true });
              return;
            }

            // Списание ставки и создание durable session — одна DB-транзакция.
            const deductResult = await withFinancialLock(guildId, userId, async () => {
              try {
                return await beginBlackjackSession(guildId, userId, sessionId, currentBet);
              } catch (err: any) {
                if (err?.message === 'insufficient_funds' || err?.message === 'dirty_blocked') return { error: 'no_money' as const };
                throw err;
              }
            });

            if (deductResult === null || 'error' in deductResult) {
              await redis.del(pKey).catch(() => null);
              await i.reply({
                content: '❌ Ошибка при списании ставки. Возможно, ваш баланс изменился.',
                ephemeral: true,
              });
              return;
            }

            wallet = deductResult.wallet;
            playingState = 'playing';
            doubled = false;
            currentSessionId = sessionId;
            totalBet = currentBet;

            // Раздача
            deck = newDeck();
            playerHand = [deck.pop()!, deck.pop()!];
            dealerHand = [deck.pop()!, deck.pop()!];

            // Проверяем мгновенный блэкджек у игрока
            if (isBlackjack(playerHand)) {
              const winAmount = Math.floor(currentBet * CASINO_DEFAULTS.blackjackBjMultiplier);
              const net = winAmount - currentBet;
              playingState = 'idle';
              const settled = await settleBlackjackSession(
                guildId, userId, sessionId, winAmount, 0, TX.CASINO_BJ, 'BJ: Блэкджек!',
              );
              wallet = settled.wallet;
              currentSessionId = null;
              await redis.del(pKey).catch(() => null);

              await i.update({
                embeds: [buildEmbed(playerHand, dealerHand, false, net, 'blackjack')],
                components: [getBetButtons(false)],
              });
              await newsCasinoWin(client, guildId, userId, 'blackjack', currentBet, net, locale).catch(() => {});
              return;
            }

            // Обычная раздача карт, выводим кнопки хода
            await i.update({
              embeds: [buildEmbed(playerHand, dealerHand, true, 0, 'playing')],
              components: [getGameButtons(wallet >= currentBet, false)],
            });
          }
        } else {
          // Игровая фаза (playing)
          if (i.customId === 'hit') {
            playerHand.push(deck.pop()!);
            const pVal = handValue(playerHand);

            if (pVal > 21) {
              // Перебор
              playingState = 'idle';
              if (!currentSessionId) throw new Error('session_not_found');
              const settled = await settleBlackjackSession(
                guildId, userId, currentSessionId, 0, totalBet, TX.CASINO_LOSE, 'BJ: bust',
              );
              wallet = settled.wallet;
              currentSessionId = null;
              await redis.del(pKey).catch(() => null);

              await i.update({
                embeds: [buildEmbed(playerHand, dealerHand, false, -totalBet, 'bust')],
                components: [getBetButtons(false)],
              });
              return;
            }

            await i.update({
              embeds: [buildEmbed(playerHand, dealerHand, true, 0, 'playing')],
              components: [getGameButtons(wallet >= currentBet, false)],
            });
          }

          if (i.customId === 'double') {
            if (doubled || !currentSessionId) {
              await i.reply({ content: '❌ Удвоение для этой партии уже недоступно.', ephemeral: true });
              return;
            }
            // Списываем доп. ставку
            const doubleResult = await withFinancialLock(guildId, userId, async () => {
              try {
                return await doubleBlackjackSession(guildId, userId, currentSessionId!, currentBet);
              } catch (err: any) {
                if (err?.message === 'insufficient_funds' || err?.message === 'dirty_blocked') return { error: 'no_money' as const };
                throw err;
              }
            });

            if (doubleResult === null || 'error' in doubleResult) {
              await i.reply({
                content: '❌ У вас недостаточно денег для удвоения!',
                ephemeral: true,
              });
              return;
            }

            wallet = doubleResult.wallet;
            totalBet = doubleResult.totalBet;
            doubled = true;
            playerHand.push(deck.pop()!);
            const pVal = handValue(playerHand);

            if (pVal > 21) {
              // Перебор при удвоении
              playingState = 'idle';
              const sessionId = currentSessionId!;
              const settled = await settleBlackjackSession(
                guildId, userId, sessionId, 0, totalBet, TX.CASINO_LOSE, 'BJ: double bust',
              );
              wallet = settled.wallet;
              currentSessionId = null;
              await redis.del(pKey).catch(() => null);

              await i.update({
                embeds: [buildEmbed(playerHand, dealerHand, false, -totalBet, 'bust')],
                components: [getBetButtons(false)],
              });
              return;
            }

            // Играем за дилера
            playingState = 'idle';
            const sessionId = currentSessionId!;
            const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, totalBet, sessionId);
            wallet = finalResult.wallet;
            currentSessionId = null;
            await redis.del(pKey).catch(() => null);

            await i.update({
              embeds: [buildEmbed(playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
              components: [getBetButtons(false)],
            });
            if (finalResult.net > 0) {
              await newsCasinoWin(client, guildId, userId, 'blackjack', currentBet * 2, finalResult.net, locale).catch(() => {});
            }
          }

          if (i.customId === 'stand') {
            // Играем за дилера
            if (!currentSessionId) throw new Error('session_not_found');
            playingState = 'idle';
            const sessionId = currentSessionId;
            const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, totalBet, sessionId);
            wallet = finalResult.wallet;
            currentSessionId = null;
            await redis.del(pKey).catch(() => null);

            await i.update({
              embeds: [buildEmbed(playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
              components: [getBetButtons(false)],
            });
            if (finalResult.net > 0) {
              await newsCasinoWin(client, guildId, userId, 'blackjack', currentBet, finalResult.net, locale).catch(() => {});
            }
          }
        }
      } catch (err) {
        log.error('Ошибка в интерактивном блэкджеке', err);
      } finally {
        actionInFlight = false;
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'module_unload' || !canProcessEconomyCollector(guildId)) return;
      try {
        if (playingState === 'playing') {
          // Если таймаут во время игры — автоматически стоим
          if (!currentSessionId) throw new Error('session_not_found');
          playingState = 'idle';
          const sessionId = currentSessionId;
          const finalResult = await resolveDealerAndPay(deck, dealerHand, playerHand, guildId, userId, totalBet, sessionId);
          currentSessionId = null;
          await redis.del(pKey).catch(() => null);
          await interaction.editReply({
            embeds: [buildEmbed(playerHand, dealerHand, false, finalResult.net, finalResult.outcome)],
            components: [],
          }).catch(() => {});
        } else {
          await interaction.editReply({
            components: [],
          }).catch(() => {});
        }
      } catch (err) {
        log.debug('Не удалось закрыть blackjack-панель', { error: String(err) });
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
  sessionId: string,
): Promise<{ net: number; outcome: string; wallet: number }> {
  // Дилер тянет до >=17
  while (handValue(dealerHand) < 17) {
    dealerHand.push(deck.pop()!);
  }

  const pVal = handValue(playerHand);
  const dVal = handValue(dealerHand);

  let net = 0;
  let outcome = 'lose';
  let newWallet = 0;

  if (dVal > 21 || pVal > dVal) {
    const winAmount = Math.floor(bet * CASINO_DEFAULTS.blackjackMultiplier);
    const r = await settleBlackjackSession(
      guildId, userId, sessionId, winAmount, 0, TX.CASINO_WIN, `BJ: ${pVal} vs ${dVal}`,
    );
    net = winAmount - bet;
    outcome = 'win';
    newWallet = r.wallet;
  } else if (pVal === dVal) {
    const r = await settleBlackjackSession(
      guildId, userId, sessionId, bet, 0, TX.CASINO_WIN, `BJ: push ${pVal}`,
    );
    net = 0;
    outcome = 'push';
    newWallet = r.wallet;
  } else {
    // Проигрыш: списанная ставка одним settlement переводится в казну.
    const settled = await settleBlackjackSession(
      guildId, userId, sessionId, 0, bet, TX.CASINO_LOSE, `BJ: ${pVal} vs ${dVal}`,
    );
    net = -bet;
    outcome = 'lose';
    newWallet = settled.wallet;
  }

  return { net, outcome, wallet: newWallet };
}

export default blackjackCommand;
