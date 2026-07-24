// ═══════════════════════════════════════════════
//  /launder — отмыть грязные шекели с комиссией.
//
//  • amount:N — отмыть N (или 0 = всё)
//  • Комиссия dirtyLaunderTax % (по умолчанию 30)
//  • Снимает amount из dirtyAmount, удерживает tax из wallet,
//    остальное остаётся в кошельке как чистое.
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import {
  getEcoConfig,
  getOrCreateProfile,
  invalidateProfileCache,
} from '../database';
import { withFinancialLock, fmt } from '../profile';
import { ecoError, ecoLocked } from '../embeds';
import { DIRTY_DEFAULTS, EMOJI, TX } from '../constants';
import { pickPhrase } from '../phrases';

const log = logger.child('Economy:Launder');

const launderCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('launder')
    .setDescription('Отмыть грязные шекели (комиссия!)')
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Сумма для отмыва (0 = всё)')
        .setMinValue(0)
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.launder.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    let amount = interaction.options.getInteger('amount', true);

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    if (config.dirtyEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.launder.error_disabled', locale))], flags: MessageFlags.Ephemeral });
      return;
    }

    const taxPct = config.dirtyLaunderTax ?? DIRTY_DEFAULTS.launderTax;

    const result = await withFinancialLock(guildId, userId, async () => {
      const profile = await getOrCreateProfile(guildId, userId);
      const dirty = profile.dirtyAmount ?? 0;

      if (dirty <= 0) return { type: 'no_dirty' as const };
      if (amount === 0) amount = dirty;
      if (amount > dirty) return { type: 'too_much' as const, dirty };

      const tax = Math.ceil((amount * taxPct) / 100);
      if (profile.wallet < tax) return { type: 'poor' as const, tax };

      const db = getDatabase();
      let netAmount = 0;
      let finalTax = 0;
      try {
        await db.$transaction(async (tx) => {
          const fresh = await tx.economyProfile.findUnique({
            where: { guildId_userId: { guildId, userId } },
          });
          if (!fresh) throw new Error('no_profile');
          const freshDirty = fresh.dirtyAmount ?? 0;
          if (freshDirty <= 0) throw new Error('no_dirty');
          if (amount > freshDirty) throw new Error('too_much');
          if (fresh.wallet < tax) throw new Error('poor');

          finalTax = tax;
          netAmount = amount - tax;

          const updated = await tx.economyProfile.update({
            where: { guildId_userId: { guildId, userId } },
            data: {
              wallet: { decrement: tax },
              totalSpent: tax > 0 ? { increment: BigInt(tax) } : undefined,
              dirtyAmount: { decrement: amount },
            },
          });
          if (updated.wallet < 0 || updated.dirtyAmount < 0) throw new Error('race');

          if (updated.dirtyAmount === 0) {
            await tx.economyProfile.update({
              where: { guildId_userId: { guildId, userId } },
              data: { dirtyClearAt: null },
            });
          }

          if (tax > 0) {
            const gov = await tx.economyProfile.upsert({
              where: { guildId_userId: { guildId, userId: 'government' } },
              create: { guildId, userId: 'government', wallet: tax },
              update: { wallet: { increment: tax } },
            });
            await tx.economyTransaction.create({
              data: {
                guildId, userId: 'government', type: 'tax_launder',
                amount: tax, balance: gov.wallet, profileId: gov.id, targetId: userId,
                details: `Пошлина за легализацию доходов от ${userId}`,
              },
            });
            await tx.economyTransaction.create({
              data: {
                guildId, userId, type: TX.LAUNDER_TAX,
                amount: -tax, balance: updated.wallet,
                profileId: profile.id,
                details: i18n.t('economy.cmd.launder.tx_tax', locale, { amount: fmt(amount) }),
              },
            });
          }

          await tx.economyTransaction.create({
            data: {
              guildId, userId, type: TX.LAUNDER_NET,
              amount: 0, balance: updated.wallet,
              profileId: profile.id,
              details: i18n.t('economy.cmd.launder.tx_net', locale, { net: fmt(netAmount), amount: fmt(amount) }),
            },
          });
        });
      } catch (err: any) {
        const msg = err?.message;
        if (msg === 'no_dirty') return { type: 'no_dirty' as const };
        if (msg === 'too_much') return { type: 'too_much' as const, dirty };
        if (msg === 'poor') return { type: 'poor' as const, tax };
        log.error('launder TX failed', err);
        return { type: 'tx_fail' as const };
      }

      await invalidateProfileCache(guildId, userId);
      return { type: 'ok' as const, amount, tax: finalTax, net: netAmount };
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
      return;
    }

    switch (result.type) {
      case 'no_dirty':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.launder.error_no_dirty', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'too_much':
        await interaction.reply({
          embeds: [ecoError(pickPhrase('economy.cmd.launder.phrase_too_much', locale, { dirty: fmt(result.dirty) }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'poor':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.launder.error_poor', locale, { tax: fmt(result.tax) }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'tx_fail':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.launder.error_tx', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'ok': {
        const embed = new BublikEmbed()
          .setColor(0x16a085)
          .setTitle(`${EMOJI.LAUNDER} ${i18n.t('economy.cmd.launder.success_title', locale)}`)
          .setDescription(
            `${pickPhrase('economy.cmd.launder.phrase_success', locale, { amount: fmt(result.amount), net: fmt(result.net) })}\n\n` +
            `${EMOJI.SHEKEL} ${i18n.t('economy.cmd.launder.amount_line', locale, { amount: fmt(result.amount) })}\n` +
            `${EMOJI.DOWN} ${i18n.t('economy.cmd.launder.tax_line', locale, { tax: fmt(result.tax), percent: taxPct })}\n` +
            `${EMOJI.SUCCESS} ${i18n.t('economy.cmd.launder.net_line', locale, { net: fmt(result.net) })}`,
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
    }
  },
};

export default launderCommand;
