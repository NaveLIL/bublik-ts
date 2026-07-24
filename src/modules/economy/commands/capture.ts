// ═══════════════════════════════════════════════
//  /capture — Поймать преступника с ≥3 звёздами
//
//  • cooldown — 6ч охотнику
//  • шанс — 70% (+50% если охотник был жертвой target)
//  • успех: 20% кошелька цели → охотнику, -1 звезда
//  • провал: штраф охотнику
// ═══════════════════════════════════════════════

import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { GuildMember } from 'discord.js';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import {
  getEcoConfig,
  getOrCreateProfile,
  invalidateProfileCache,
  wasRecentVictim,
} from '../database';
import { getUserPerks } from '../perks';
import { applyWalletDeltaInTransaction, withFinancialLock, checkCooldown, fmt } from '../profile';
import { ecoError, ecoLocked, buildCooldownEmbed } from '../embeds';
import { WANTED_DEFAULTS, EMOJI, TX } from '../constants';
import { getCaptureDenied, isConfiguredEconomyOwner } from '../ownerImmunity';
import { pickPhrase } from '../phrases';
import { newsCapture } from '../news';
import { secureChancePercent } from '../random';

const log = logger.child('Economy:Capture');

export function wantedNextDecayAfterCapture(currentStars: number): null | undefined {
  return currentStars <= 1 ? null : undefined;
}

const captureCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('capture')
    .setDescription('Поймать разыскиваемого преступника')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Цель').setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.capture.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const hunterId = interaction.user.id;
    const target = interaction.options.getUser('user', true);

    if (target.bot) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.capture.error_bot', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    if (target.id === hunterId) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.capture.error_self', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    if (isConfiguredEconomyOwner(target.id)) {
      await interaction.reply({
        embeds: [ecoError(getCaptureDenied())],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], flags: MessageFlags.Ephemeral });
      return;
    }
    if (config.wantedEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.capture.error_disabled', locale))], flags: MessageFlags.Ephemeral });
      return;
    }

    const member = interaction.member as GuildMember;
    const isVictim = await wasRecentVictim(guildId, hunterId, target.id, 7 * 24 * 60 * 60 * 1000);
    const isPolice = config.policeRoleId ? member.roles.cache.has(config.policeRoleId) : false;

    if (!isPolice && !isVictim) {
      await interaction.reply({
        embeds: [ecoError(`👮 **Доступ ограничен!**\nЛовить разыскиваемых могут только сотрудники полиции (ЯМАМ/МАГАВ) или сами жертвы преступлений в течение 7 дней.`)],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const captureMin = config.wantedCaptureMin ?? WANTED_DEFAULTS.captureMin;
    const baseChance = config.wantedCaptureChance ?? WANTED_DEFAULTS.captureChance;
    const victimBonus = config.wantedVictimBonus ?? WANTED_DEFAULTS.victimBonus;
    const cdMs = Number(config.wantedCaptureCooldown ?? WANTED_DEFAULTS.captureCooldown);
    const reward = config.wantedCaptureReward ?? WANTED_DEFAULTS.captureReward;
    const fine = config.wantedCaptureFine ?? WANTED_DEFAULTS.captureFine;

    const result = await withFinancialLock(guildId, hunterId, async () => {
      const hunter = await getOrCreateProfile(guildId, hunterId);
      const targetProfile = await getOrCreateProfile(guildId, target.id);

      const remaining = checkCooldown(hunter.lastCapture, cdMs);
      if (remaining > 0) return { type: 'cooldown' as const, remaining };

      if ((targetProfile.wantedStars ?? 0) < captureMin) {
        return { type: 'low_stars' as const, stars: targetProfile.wantedStars ?? 0, min: captureMin };
      }

      if (hunter.wallet < fine) return { type: 'poor' as const, fine };

      // Мы уже вычислили isVictim выше
      const hunterPerks = await getUserPerks(guildId, hunterId);
      let chance = baseChance + (isVictim ? victimBonus : 0) + (hunterPerks.captureBonus ?? 0);
      chance = Math.max(5, Math.min(98, chance));

      const isSuccess = secureChancePercent(chance);
      const db = getDatabase();

      if (isSuccess) {
        let paidReward = 0;
        let paidBonus = 0;
        let confiscatedDirty = 0;
        let dirtyReward = 0;

        try {
          await db.$transaction(async (tx) => {
            const treasury = await tx.economyProfile.upsert({
              where: { guildId_userId: { guildId, userId: 'government' } },
              create: { guildId, userId: 'government' },
              update: {},
            });
            for (const id of [hunter.id, targetProfile.id, treasury.id].sort()) {
              await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${id} FOR UPDATE`;
            }
            const freshTarget = await tx.economyProfile.findUniqueOrThrow({ where: { id: targetProfile.id } });
            const freshHunter = await tx.economyProfile.findUniqueOrThrow({ where: { id: hunter.id } });
            if (freshTarget.wantedStars < captureMin) throw new Error('target_no_longer_wanted');
            if (checkCooldown(freshHunter.lastCapture, cdMs) > 0) throw new Error('capture_already_processed');

            const trueReward = Math.max(0, Math.min(
              Math.floor(freshTarget.wallet * reward / 100),
              freshTarget.wallet,
            ));
            paidReward = trueReward;

            const dirtyToConfiscate = freshTarget.dirtyAmount ?? 0;
            const actualConfiscatedDirty = Math.min(dirtyToConfiscate, freshTarget.wallet - trueReward);
            confiscatedDirty = actualConfiscatedDirty;

            const hunterDirtyReward = Math.floor(actualConfiscatedDirty * 0.5);
            dirtyReward = hunterDirtyReward;

            const stateDirtyTax = actualConfiscatedDirty - hunterDirtyReward;

            const freshTreasury = await tx.economyProfile.findUniqueOrThrow({ where: { id: treasury.id } });
            const desiredBonus = Math.floor(trueReward * 0.5);
            const bonusReward = Math.min(desiredBonus, freshTreasury.wallet + stateDirtyTax);
            paidBonus = bonusReward;
            const totalHunterEarned = trueReward + bonusReward + hunterDirtyReward;

            const updatedHunter = await tx.economyProfile.update({
              where: { guildId_userId: { guildId, userId: hunterId } },
              data: {
                wallet: { increment: totalHunterEarned },
                totalEarned: totalHunterEarned > 0 ? { increment: BigInt(totalHunterEarned) } : undefined,
                lastCapture: new Date(),
              },
            });

            const updatedTarget = await tx.economyProfile.update({
              where: { guildId_userId: { guildId, userId: target.id } },
              data: {
                wallet: { decrement: trueReward + actualConfiscatedDirty },
                totalSpent: (trueReward + actualConfiscatedDirty) > 0 ? { increment: BigInt(trueReward + actualConfiscatedDirty) } : undefined,
                wantedStars: freshTarget.wantedStars > 0 ? { decrement: 1 } : undefined,
                wantedNextDecay: wantedNextDecayAfterCapture(freshTarget.wantedStars),
                dirtyAmount: 0,
                dirtyClearAt: null,
              },
            });
            if (updatedTarget.wallet < 0) throw new Error('insufficient');

            const treasuryDelta = stateDirtyTax - bonusReward;
            if (treasuryDelta !== 0) {
              const gov = await tx.economyProfile.update({
                where: { id: freshTreasury.id },
                data: { wallet: { increment: treasuryDelta } },
              });
              await tx.economyTransaction.create({
                data: {
                  guildId, userId: 'government', type: 'capture_treasury_net',
                  amount: treasuryDelta, balance: gov.wallet, profileId: gov.id, targetId: target.id,
                  details: `Конфискация грязных денег минус премия за арест ${target.id}`,
                },
              });
              await invalidateProfileCache(guildId, 'government');
            }

            if (trueReward > 0) {
              await tx.economyTransaction.create({
                data: {
                  guildId, userId: hunterId, type: 'capture_confiscate',
                  amount: trueReward, balance: updatedHunter.wallet - bonusReward - hunterDirtyReward,
                  profileId: hunter.id, targetId: target.id,
                  details: `Конфискация средств у ${target.id}`,
                },
              });
              if (bonusReward > 0) {
                await tx.economyTransaction.create({
                  data: {
                    guildId, userId: hunterId, type: 'capture_bonus',
                    amount: bonusReward, balance: updatedHunter.wallet - hunterDirtyReward,
                    profileId: hunter.id,
                    details: `Государственная премия (ЯМАМ) за арест`,
                  },
                });
              }
              await tx.economyTransaction.create({
                data: {
                  guildId, userId: target.id, type: TX.CAPTURE_LOSS,
                  amount: -trueReward, balance: updatedTarget.wallet + actualConfiscatedDirty,
                  profileId: targetProfile.id, targetId: hunterId,
                  details: `Конфисковано полицией (${hunterId})`,
                },
              });
            }

            if (actualConfiscatedDirty > 0) {
              await tx.economyTransaction.create({
                data: {
                  guildId, userId: target.id, type: 'capture_dirty_confiscated_loss',
                  amount: -actualConfiscatedDirty, balance: updatedTarget.wallet,
                  profileId: targetProfile.id, targetId: hunterId,
                  details: `Конфискация грязных денег полицией (${hunterId})`,
                },
              });

              if (hunterDirtyReward > 0) {
                await tx.economyTransaction.create({
                  data: {
                    guildId, userId: hunterId, type: 'capture_dirty_reward',
                    amount: hunterDirtyReward, balance: updatedHunter.wallet,
                    profileId: hunter.id,
                    details: `50% премия от конфискованных грязных денег у ${target.id}`,
                  },
                });
              }
            }
          });
        } catch (err: any) {
          log.error(`capture TX failed`, err);
          return { type: 'tx_fail' as const };
        }

        await invalidateProfileCache(guildId, hunterId);
        await invalidateProfileCache(guildId, target.id);

        return { type: 'success' as const, reward: paidReward, bonusReward: paidBonus, isVictim, confiscatedDirty, dirtyReward };
      } else {
        // Провал
        await db.$transaction(async (tx) => {
          const freshHunter = await tx.economyProfile.findUnique({
            where: { guildId_userId: { guildId, userId: hunterId } },
          });
          if (!freshHunter) return;
          await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${freshHunter.id} FOR UPDATE`;
          const lockedHunter = await tx.economyProfile.findUniqueOrThrow({ where: { id: freshHunter.id } });
          const actualFine = Math.min(fine, lockedHunter.wallet);
          if (actualFine > 0) {
            await applyWalletDeltaInTransaction(
              tx, guildId, hunterId, -actualFine, TX.CAPTURE_FINE, 'Capture fail', target.id,
            );
          }
          await tx.economyProfile.update({
            where: { id: lockedHunter.id },
            data: { lastCapture: new Date() },
          });
        });
        await invalidateProfileCache(guildId, hunterId);
        return { type: 'fail' as const, fine };
      }
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], flags: MessageFlags.Ephemeral });
      return;
    }

    switch (result.type) {
      case 'cooldown':
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.capture.cooldown_name', locale), result.remaining, locale)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'low_stars':
        await interaction.reply({
          embeds: [ecoError(pickPhrase('economy.cmd.capture.error_low_stars', locale, { robber: `<@${target.id}>`, stars: result.stars, min: result.min }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'poor':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.capture.error_poor', locale, { fine: fmt(result.fine) }))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'tx_fail':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.capture.error_tx', locale))],
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'success': {
        const bonusReward = result.bonusReward;
        const dirtyConfiscated = result.confiscatedDirty ?? 0;
        const dirtyReward = result.dirtyReward ?? 0;
        const totalReward = result.reward + bonusReward + dirtyReward;

        const phrase = result.isVictim
          ? `🚨 **Месть правосудия!** Вы лично заковали <@${target.id}> в наручники!`
          : `🚨 **Отличная работа, офицер!** Вы успешно задержали преступника <@${target.id}>!`;

        let desc = `${phrase}\n\n` +
          `${EMOJI.SHEKEL} **Конфисковано чистых средств:** ${fmt(result.reward)}\n` +
          `${EMOJI.UP} **Премия МВД:** ${fmt(bonusReward)}\n`;

        if (dirtyConfiscated > 0) {
          desc += `💸 **Изъято грязных денег:** ${fmt(dirtyConfiscated)}\n` +
            `💼 **Доля офицера (50%):** ${fmt(dirtyReward)}\n` +
            `🏛️ **Поступило в казну (50%):** ${fmt(dirtyConfiscated - dirtyReward)}\n`;
        }

        desc += `\n🔹 **Итого заработано вами:** **${fmt(totalReward)}**\n\n` +
          `${EMOJI.WANTED} Преступник потерял 1 звезду розыска, а его грязные деньги полностью конфискованы.`;

        const embed = new BublikEmbed()
          .setColor(0x3498db)
          .setTitle(`${EMOJI.CAPTURE} Операция МАГАВ прошла успешно!`)
          .setDescription(desc);
        await interaction.reply({ embeds: [embed] });
        await newsCapture(client, guildId, hunterId, target.id, result.reward, locale).catch(() => {});
        return;
      }
      case 'fail': {
        const embed = new BublikEmbed()
          .setColor(0xe74c3c)
          .setTitle(`${EMOJI.CAPTURE} Операция провалена`)
          .setDescription(
            `🚔 Подозреваемый <@${target.id}> оказал сопротивление и скрылся в переулках!\n\n` +
            `${EMOJI.DOWN} **Штраф за повреждение экипировки:** ${fmt(result.fine)}`,
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
    }
  },
};

export default captureCommand;
