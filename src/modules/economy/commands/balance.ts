// ═══════════════════════════════════════════════
//  /balance, /pay, /deposit, /withdraw
//
//  Команды управления балансом.
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getOrCreateProfile, getEcoConfig, getPbRoleIds } from '../database';
import {
  getPbTier,
  depositToBank,
  withdrawFromBank,
  transferShekels,
  withFinancialLock,
  fmt,
} from '../profile';
import {
  buildBalanceEmbed,
  buildDepositEmbed,
  buildWithdrawEmbed,
  buildTransferEmbed,
  ecoError,
  ecoLocked,
} from '../embeds';
import { newsTransfer } from '../news';
import { DEFAULTS } from '../constants';

const log = logger.child('Economy:Balance');

// ═══════════════════════════════════════════════
//  /balance
// ═══════════════════════════════════════════════

const balanceCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Показать ваш баланс шекелей')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Баланс другого пользователя')
        .setRequired(false),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.balance.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const targetUser = interaction.options.getUser('user') || interaction.user;

    if (targetUser.bot) {
      await interaction.reply({ embeds: [ecoError('Боты не участвуют в экономике.')], ephemeral: true });
      return;
    }

    const member = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.reply({ embeds: [ecoError('Пользователь не найден.')], ephemeral: true });
      return;
    }

    const profile = await getOrCreateProfile(guildId, targetUser.id);

    const pbRoleIds = await getPbRoleIds(guildId);

    // PB-тир
    const { multiplier, bankLimit, tierName } = getPbTier(member, pbRoleIds);

    await interaction.reply({
      embeds: [
        buildBalanceEmbed(
          member,
          profile.wallet,
          profile.bank,
          bankLimit,
          tierName,
          multiplier,
          profile.dailyStreak,
          Number(profile.totalEarned),
          Number(profile.totalSpent),
        ),
      ],
    });
  },
};

// ═══════════════════════════════════════════════
//  /deposit
// ═══════════════════════════════════════════════

const depositCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Внести шекели в банк')
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Сумма (или 0 = всё)')
        .setMinValue(0)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.deposit.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const member = interaction.member as GuildMember;
    let amount = interaction.options.getInteger('amount', true);

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);

      // 0 = всё
      if (amount === 0) amount = profile.wallet;
      if (amount <= 0) {
        return { success: false, wallet: profile.wallet, bank: profile.bank, error: 'insufficient_funds' } as import('../profile').BalanceResult;
      }

      const { bankLimit } = getPbTier(member, await getPbRoleIds(guildId));
      return depositToBank(guildId, userId, amount, bankLimit);
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        insufficient_funds: 'Недостаточно шекелей в кошельке.',
        bank_full: 'Ваш банк заполнен. Повысьте ПБ-тир для увеличения лимита!',
        invalid_amount: 'Некорректная сумма.',
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || 'Ошибка операции.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildDepositEmbed(member, amount, result.wallet, result.bank)],
    });
  },
};

// ═══════════════════════════════════════════════
//  /withdraw
// ═══════════════════════════════════════════════

const withdrawCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Снять шекели из банка (комиссия!)')
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Сумма (или 0 = всё)')
        .setMinValue(0)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.withdraw.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const member = interaction.member as GuildMember;
    let amount = interaction.options.getInteger('amount', true);

    const config = await getEcoConfig(guildId);
    const taxPercent = config?.bankWithdrawTax ?? DEFAULTS.bankWithdrawTax;

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);

      // 0 = всё
      if (amount === 0) amount = profile.bank;
      if (amount <= 0) {
        return { success: false, wallet: profile.wallet, bank: profile.bank, tax: 0, error: 'insufficient_bank' } as import('../profile').BalanceResult & { tax: number };
      }

      return withdrawFromBank(guildId, userId, amount, taxPercent);
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        insufficient_bank: 'Недостаточно шекелей в банке.',
        invalid_amount: 'Некорректная сумма.',
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || 'Ошибка операции.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildWithdrawEmbed(member, amount - result.tax, result.tax, result.wallet, result.bank)],
    });
  },
};

// ═══════════════════════════════════════════════
//  /pay
// ═══════════════════════════════════════════════

const payCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Перевести шекели другому пользователю (налог!)')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Получатель')
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Сумма перевода')
        .setMinValue(1)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.pay.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const senderId = interaction.user.id;
    const member = interaction.member as GuildMember;
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.bot) {
      await interaction.reply({ embeds: [ecoError('Нельзя переводить ботам.')], ephemeral: true });
      return;
    }

    const config = await getEcoConfig(guildId);
    const taxPercent = config?.transferTax ?? DEFAULTS.transferTax;

    const result = await withFinancialLock(guildId, senderId, async () => {
      return transferShekels(guildId, senderId, target.id, amount, taxPercent);
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        self_transfer: 'Нельзя переводить самому себе.',
        insufficient_funds: 'Недостаточно шекелей в кошельке.',
        invalid_amount: 'Некорректная сумма.',
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || 'Ошибка перевода.')],
        ephemeral: true,
      });
      return;
    }

    const received = amount - result.tax;

    await interaction.reply({
      embeds: [buildTransferEmbed(member, target.id, amount, result.tax, received)],
    });

    // Новость о крупном переводе
    await newsTransfer(client, guildId, senderId, target.id, amount, result.tax).catch(() => {});
  },
};

export { balanceCommand, depositCommand, withdrawCommand, payCommand };
