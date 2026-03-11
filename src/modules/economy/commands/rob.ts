// ═══════════════════════════════════════════════
//  /rob — Ограбление кошелька другого игрока
//
//  • Кулдаун 4ч (настраивается)
//  • Шанс успеха 45% (настраивается)
//  • При успехе: крадём 10-30% кошелька жертвы
//  • При провале: штраф из своего кошелька
//  • Нельзя грабить ботов, себя, бедных
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getOrCreateProfile, createTransaction, invalidateProfileCache } from '../database';
import { withFinancialLock, checkCooldown, formatCooldown, fmt } from '../profile';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked, buildCooldownEmbed } from '../embeds';
import { ROB_DEFAULTS, COOLDOWNS, EMOJI, TX, CURRENCY } from '../constants';

const log = logger.child('Economy:Rob');

const robCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('rob')
    .setDescription('Ограбить кошелёк другого игрока')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Жертва')
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.rob.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const robberId = interaction.user.id;
    const target = interaction.options.getUser('user', true);

    // Базовые проверки
    if (target.bot) {
      await interaction.reply({ embeds: [ecoError('Нельзя грабить ботов.')], ephemeral: true });
      return;
    }
    if (target.id === robberId) {
      await interaction.reply({ embeds: [ecoError('Нельзя грабить самого себя.')], ephemeral: true });
      return;
    }

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError('Экономика отключена.')], ephemeral: true });
      return;
    }
    if (config.robEnabled === false) {
      await interaction.reply({ embeds: [ecoError('Ограбления отключены на этом сервере.')], ephemeral: true });
      return;
    }

    const cooldownMs = config.robCooldown ? Number(config.robCooldown) : COOLDOWNS.rob;
    const successRate = config.robSuccessRate ?? ROB_DEFAULTS.successRate;
    const minSteal = config.robMinSteal ?? ROB_DEFAULTS.minSteal;
    const maxPercent = config.robMaxPercent ?? ROB_DEFAULTS.maxPercent;
    const fineAmount = config.robFine ?? ROB_DEFAULTS.fine;
    const minVictimWallet = ROB_DEFAULTS.minVictimWallet;

    const result = await withFinancialLock(guildId, robberId, async () => {
      const robberProfile = await getOrCreateProfile(guildId, robberId);

      // Кулдаун
      const remaining = checkCooldown(robberProfile.lastRob, cooldownMs);
      if (remaining > 0) {
        return { type: 'cooldown' as const, remaining };
      }

      // Проверяем жертву
      const victimProfile = await getOrCreateProfile(guildId, target.id);
      if (victimProfile.wallet < minVictimWallet) {
        return { type: 'poor_victim' as const, minWallet: minVictimWallet };
      }

      // Проверяем, что у грабителя хватит на штраф
      if (robberProfile.wallet < fineAmount) {
        return { type: 'poor_robber' as const, fine: fineAmount };
      }

      const db = getDatabase();
      const isSuccess = Math.random() * 100 < successRate;

      if (isSuccess) {
        // Крадём 10-maxPercent% кошелька жертвы
        const stealPercent = 10 + Math.random() * (maxPercent - 10);
        const stolen = Math.max(minSteal, Math.floor(victimProfile.wallet * stealPercent / 100));

        // Атомарная транзакция
        await db.$transaction(async (tx) => {
          const freshVictim = await tx.economyProfile.findUnique({
            where: { guildId_userId: { guildId, userId: target.id } },
          });
          if (!freshVictim || freshVictim.wallet < stolen) throw new Error('insufficient');

          const updatedRobber = await tx.economyProfile.update({
            where: { guildId_userId: { guildId, userId: robberId } },
            data: {
              wallet: { increment: stolen },
              totalEarned: { increment: BigInt(stolen) },
              lastRob: new Date(),
            },
          });

          const updatedVictim = await tx.economyProfile.update({
            where: { guildId_userId: { guildId, userId: target.id } },
            data: {
              wallet: { decrement: stolen },
              totalSpent: { increment: BigInt(stolen) },
            },
          });

          await tx.economyTransaction.create({
            data: {
              guildId, userId: robberId, type: TX.ROB_SUCCESS,
              amount: stolen, balance: updatedRobber.wallet,
              profileId: robberProfile.id, targetId: target.id,
              details: `Ограбил <@${target.id}>`,
            },
          });

          await tx.economyTransaction.create({
            data: {
              guildId, userId: target.id, type: TX.ROB_VICTIM,
              amount: -stolen, balance: updatedVictim.wallet,
              profileId: victimProfile.id, targetId: robberId,
              details: `Ограблен <@${robberId}>`,
            },
          });
        });

        await invalidateProfileCache(guildId, robberId);
        await invalidateProfileCache(guildId, target.id);

        return { type: 'success' as const, stolen, victimId: target.id };
      } else {
        // Провал — штраф
        await db.$transaction(async (tx) => {
          const updatedRobber = await tx.economyProfile.update({
            where: { guildId_userId: { guildId, userId: robberId } },
            data: {
              wallet: { decrement: fineAmount },
              totalSpent: { increment: BigInt(fineAmount) },
              lastRob: new Date(),
            },
          });

          await tx.economyTransaction.create({
            data: {
              guildId, userId: robberId, type: TX.ROB_FINE,
              amount: -fineAmount, balance: updatedRobber.wallet,
              profileId: robberProfile.id, targetId: target.id,
              details: `Попался при ограблении <@${target.id}>`,
            },
          });
        });

        await invalidateProfileCache(guildId, robberId);

        return { type: 'fail' as const, fine: fineAmount, victimId: target.id };
      }
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      return;
    }

    switch (result.type) {
      case 'cooldown':
        await interaction.reply({
          embeds: [buildCooldownEmbed('Ограбление', result.remaining)],
          ephemeral: true,
        });
        return;

      case 'poor_victim':
        await interaction.reply({
          embeds: [ecoError(`У <@${target.id}> слишком мало шекелей (минимум ${fmt(result.minWallet)} в кошельке).`)],
          ephemeral: true,
        });
        return;

      case 'poor_robber':
        await interaction.reply({
          embeds: [ecoError(`Вам нужно минимум ${fmt(result.fine)} в кошельке на случай штрафа.`)],
          ephemeral: true,
        });
        return;

      case 'success': {
        const embed = new BublikEmbed()
          .setColor(0x2ecc71)
          .setAuthor({
            name: `${interaction.user.displayName} — Ограбление`,
            iconURL: interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setDescription(
            `${EMOJI.ROB} Вы успешно обчистили карманы <@${result.victimId}>!\n\n` +
            `${EMOJI.SHEKEL} **Украдено:** ${fmt(result.stolen)}\n` +
            `${EMOJI.SUCCESS} Деньги уже в вашем кошельке.`,
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }

      case 'fail': {
        const embed = new BublikEmbed()
          .setColor(0xe74c3c)
          .setAuthor({
            name: `${interaction.user.displayName} — Ограбление`,
            iconURL: interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setDescription(
            `${EMOJI.ROB} Вас поймали за руку при попытке ограбить <@${result.victimId}>!\n\n` +
            `${EMOJI.DOWN} **Штраф:** ${fmt(result.fine)}\n` +
            `${EMOJI.ERROR} Полиция Израиля не дремлет!`,
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
    }
  },
};

export default robCommand;
