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
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getOrCreateProfile, getEcoConfig, getPbRoleIds } from '../database';
import { PB_TIERS } from '../constants';
import {
  getPbTier,
  depositToBank,
  withdrawFromBank,
  transferShekels,
  withFinancialLock,
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
import { pickPhrase } from '../phrases';

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

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    const targetUser = interaction.options.getUser('user') || interaction.user;

    if (targetUser.bot) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.balance.error_bot', locale))], ephemeral: true });
      return;
    }

    const member = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.balance.error_user_not_found', locale))], ephemeral: true });
      return;
    }

    const profile = await getOrCreateProfile(guildId, targetUser.id);

    const pbRoleIds = await getPbRoleIds(guildId);

    // PB-тир
    const { multiplier, bankLimit, tierName, tierIndex } = getPbTier(member, pbRoleIds);

    const pbVoiceSeconds = Number((profile as any).pbVoiceSeconds ?? 0);
    const pbHours = pbVoiceSeconds / 3600;

    // Прогресс считаем до следующего настроенного тира
    let pbHoursText = `${Math.floor(pbHours)}ч`;
    let nextIdx = -1;
    for (let i = tierIndex + 1; i < PB_TIERS.length; i++) {
      if (pbRoleIds[i]) {
        nextIdx = i;
        break;
      }
    }

    if (nextIdx >= 0) {
      const need = PB_TIERS[nextIdx].hours;
      const pct = Math.min(100, Math.floor((pbHours / need) * 100));
      pbHoursText += ` (${pct}% до тира ${nextIdx + 1})`;
    }

    await interaction.reply({
      embeds: [
        buildBalanceEmbed(
          member,
          profile.wallet,
          profile.bank,
          bankLimit,
          tierName,
          multiplier,
          pbHoursText,
          profile.dailyStreak,
          Number(profile.totalEarned),
          Number(profile.totalSpent),
          profile.dirtyAmount ?? 0,
          locale,
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

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    const userId = interaction.user.id;
    const member = interaction.member as GuildMember;
    let amount = interaction.options.getInteger('amount', true);

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);

      // Грязные деньги нельзя класть в банк — только чистая часть кошелька доступна.
      const dirty = profile.dirtyAmount ?? 0;
      const cleanWallet = Math.max(0, profile.wallet - dirty);

      // 0 = всё (чистое)
      if (amount === 0) amount = cleanWallet;
      if (amount <= 0) {
        return { success: false, wallet: profile.wallet, bank: profile.bank, error: 'insufficient_funds' } as import('../profile').BalanceResult;
      }
      if (amount > cleanWallet) {
        return { success: false, wallet: profile.wallet, bank: profile.bank, error: 'dirty_blocked' } as import('../profile').BalanceResult;
      }

      const { bankLimit } = getPbTier(member, await getPbRoleIds(guildId));
      return depositToBank(guildId, userId, amount, bankLimit);
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        insufficient_funds: i18n.t('economy.cmd.deposit.error_insufficient_funds', locale),
        bank_full: i18n.t('economy.cmd.deposit.error_bank_full', locale),
        invalid_amount: i18n.t('economy.cmd.deposit.error_invalid_amount', locale),
        dirty_blocked: pickPhrase('economy.cmd.dirty.deposit_blocked', locale),
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || i18n.t('economy.cmd.deposit.error_default', locale))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildDepositEmbed(member, amount, result.wallet, result.bank, locale)],
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

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
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
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        insufficient_bank: i18n.t('economy.cmd.withdraw.error_insufficient_bank', locale),
        invalid_amount: i18n.t('economy.cmd.withdraw.error_invalid_amount', locale),
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || i18n.t('economy.cmd.withdraw.error_default', locale))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildWithdrawEmbed(member, amount - result.tax, result.tax, result.wallet, result.bank, locale)],
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
    const locale = await getGuildLocale(interaction.guildId);
    const senderId = interaction.user.id;
    const member = interaction.member as GuildMember;
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.bot) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.pay.error_bot', locale))], ephemeral: true });
      return;
    }

    const config = await getEcoConfig(guildId);
    const taxPercent = config?.transferTax ?? DEFAULTS.transferTax;

    const result = await transferShekels(
      guildId,
      senderId,
      target.id,
      amount,
      taxPercent,
      interaction.id,
    );

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }

    if (!result.success) {
      const msgs: Record<string, string> = {
        self_transfer: i18n.t('economy.cmd.pay.error_self_transfer', locale),
        insufficient_funds: i18n.t('economy.cmd.pay.error_insufficient_funds', locale),
        invalid_amount: i18n.t('economy.cmd.pay.error_invalid_amount', locale),
        dirty_blocked: pickPhrase('economy.cmd.dirty.pay_blocked', locale),
      };
      await interaction.reply({
        embeds: [ecoError(msgs[result.error!] || i18n.t('economy.cmd.pay.error_default', locale))],
        ephemeral: true,
      });
      return;
    }

    const received = amount - result.tax;

    await interaction.reply({
      embeds: [buildTransferEmbed(member, target.id, amount, result.tax, received, locale)],
    });

    // Новость о крупном переводе
    if (!result.duplicate) {
      await newsTransfer(client, guildId, senderId, target.id, amount, result.tax, locale).catch(() => {});
    }
  },
};

export { balanceCommand, depositCommand, withdrawCommand, payCommand };
