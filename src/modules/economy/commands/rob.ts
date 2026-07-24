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
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { isGuildAllowed } from '../../../core/Whitelist';
import { getEcoConfig, getOrCreateProfile, invalidateProfileCache, isSafeActive, consumeLockpick, consumeMask } from '../database';
import { getUserPerks } from '../perks';
import { getActiveBoosts, applyRobBoost, applyWantedMul } from '../events';
import { applyWalletDeltaInTransaction, withFinancialLock, checkCooldown, fmt } from '../profile';
import { getDatabase } from '../../../core/Database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoLocked, buildCooldownEmbed } from '../embeds';
import { ROB_DEFAULTS, COOLDOWNS, EMOJI, TX, WANTED_DEFAULTS, DIRTY_DEFAULTS, SAFE_DEFAULTS, LOCKPICK_DEFAULTS } from '../constants';
import { newsRobSuccess } from '../news';
import { getRobDenied, isConfiguredEconomyOwner } from '../ownerImmunity';
import { pickPhrase } from '../phrases';
import { secureChancePercent, secureRandomFloat } from '../random';
import { createDeferredWantedClaimInTransaction } from '../deferred-wanted';

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
    const locale = await getGuildLocale(interaction.guildId);
    const guildId = interaction.guildId!;
    const robberId = interaction.user.id;
    const target = interaction.options.getUser('user', true);

    // Базовые проверки
    if (target.bot) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.rob.error_bot', locale))], ephemeral: true });
      return;
    }
    if (target.id === robberId) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.rob.error_self', locale))], ephemeral: true });
      return;
    }
    if (isConfiguredEconomyOwner(target.id)) {
      await interaction.reply({
        embeds: [ecoError(getRobDenied())],
        ephemeral: true,
      });
      return;
    }

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.common.error_economy_disabled_short', locale))], ephemeral: true });
      return;
    }

    const isPolice = config.policeRoleId ? (interaction.member as GuildMember).roles.cache.has(config.policeRoleId) : false;
    if (isPolice) {
      await interaction.reply({
        embeds: [ecoError('👮 **Полицейский не может совершать грабежи!**\nВы при исполнении служебных обязанностей.')],
        ephemeral: true,
      });
      return;
    }

    if (config.robEnabled === false) {
      await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.rob.error_rob_disabled', locale))], ephemeral: true });
      return;
    }

    const cooldownMs = config.robCooldown ? Number(config.robCooldown) : COOLDOWNS.rob;
    const baseSuccessRate = config.robSuccessRate ?? ROB_DEFAULTS.successRate;
    const minSteal = config.robMinSteal ?? ROB_DEFAULTS.minSteal;
    const maxPercent = config.robMaxPercent ?? ROB_DEFAULTS.maxPercent;
    const fineAmount = config.robFine ?? ROB_DEFAULTS.fine;
    const minVictimWallet = ROB_DEFAULTS.minVictimWallet;
    const safeMode = (config.safeMode ?? SAFE_DEFAULTS.mode) as 'partial' | 'immune';
    const safePartialFactor = SAFE_DEFAULTS.partialFactor;
    const lockpickBonus = config.lockpickBonus ?? LOCKPICK_DEFAULTS.bonus;

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

      // Сейф жертвы (immune) — блокируем сразу, без кулдауна и штрафа.
      const victimHasSafe = isSafeActive(victimProfile);
      if (victimHasSafe && safeMode === 'immune') {
        return { type: 'safe_immune' as const };
      }

      // Отмычка: расходник, +bonus% к шансу. Списываем атомарно.
      const lockpickUsed = await consumeLockpick(guildId, robberId);

      // Маска: расходник, защищает от звезд и скрывает имя. Списываем атомарно.
      const maskUsed = await consumeMask(guildId, robberId);

      // Перки: атакующий +robBonus, жертва −robDefense
      const [robberPerks, victimPerks] = await Promise.all([
        getUserPerks(guildId, robberId),
        getUserPerks(guildId, target.id),
      ]);

      let successRate = baseSuccessRate;
      if (lockpickUsed) successRate += lockpickBonus;
      successRate += (robberPerks.robBonus ?? 0);
      successRate -= (victimPerks.robDefense ?? 0);
      successRate = Math.max(5, Math.min(98, successRate));

      const db = getDatabase();
      const isSuccess = secureChancePercent(successRate);
      const wantedOn = config.wantedEnabled !== false;
      const boosts = await getActiveBoosts(guildId);
      const wantedStars = applyWantedMul(1, boosts);
      const baseWantedDecayMs = Number(config.wantedDecayMs ?? WANTED_DEFAULTS.decayMs);
      const wantedDecayMs = Math.max(
        60_000,
        Math.floor(baseWantedDecayMs * (robberPerks.wantedDecayMul ?? 1)),
      );

      if (isSuccess) {
        // Атомарная транзакция — stolen вычисляется внутри по fresh wallet
        let stolen = 0;
        try {
          await db.$transaction(async (tx) => {
            for (const profileId of [robberProfile.id, victimProfile.id].sort()) {
              await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${profileId} FOR UPDATE`;
            }
            const freshVictim = await tx.economyProfile.findUnique({
              where: { id: victimProfile.id },
            });
            if (!freshVictim || freshVictim.wallet < minVictimWallet) throw new Error('insufficient');

            // Крадём 10-maxPercent% от РЕАЛЬНОГО кошелька жертвы
            const stealPercent = 10 + secureRandomFloat() * (maxPercent - 10);
            stolen = Math.max(minSteal, Math.floor(freshVictim.wallet * stealPercent / 100));
            // Сейф жертвы в режиме partial — режем добычу.
            if (victimHasSafe && safeMode === 'partial') {
              stolen = Math.max(1, Math.floor(stolen * safePartialFactor));
            }
            // Event-буст робберу (выходной / сезонный эвент)
            stolen = applyRobBoost(stolen, boosts);
            // Не больше того, что есть
            stolen = Math.min(stolen, freshVictim.wallet);

            const robberDisplay = maskUsed ? 'Неизвестный в маске' : `<@${robberId}>`;
            await applyWalletDeltaInTransaction(
              tx,
              guildId,
              target.id,
              -stolen,
              TX.ROB_VICTIM,
              i18n.t('economy.cmd.rob.tx_victim', locale, { robber: robberDisplay }),
              maskUsed ? undefined : robberId,
            );
            const updatedRobber = await applyWalletDeltaInTransaction(
              tx,
              guildId,
              robberId,
              stolen,
              TX.ROB_SUCCESS,
              i18n.t('economy.cmd.rob.tx_success', locale, { target: target.id }),
              target.id,
            );
            const dirtyAmount = config?.dirtyEnabled === false
              ? 0
              : Math.max(0, Math.min(stolen, Math.floor(stolen * (robberPerks.dirtyMul ?? 1))));
            await tx.economyProfile.update({
              where: { id: updatedRobber.id },
              data: {
                lastRob: new Date(),
                dirtyAmount: dirtyAmount > 0 ? { increment: dirtyAmount } : undefined,
                dirtyClearAt: dirtyAmount > 0
                  ? new Date(Date.now() + Number(config?.dirtyExpireMs ?? DIRTY_DEFAULTS.expireMs))
                  : undefined,
              },
            });
            if (!maskUsed && wantedOn) {
              await createDeferredWantedClaimInTransaction(
                tx,
                `rob-success:${guildId}:${robberId}:${interaction.id}`,
                guildId,
                robberId,
                wantedStars,
                wantedDecayMs,
                new Date(Date.now() + 300_000),
              );
            }
          });
        } catch (err: any) {
          if (err.message === 'insufficient') {
            // Жертва успела потратить деньги между проверкой и транзакцией
            return { type: 'poor_victim' as const, minWallet: minVictimWallet };
          }
          throw err;
        }

        await invalidateProfileCache(guildId, robberId);
        await invalidateProfileCache(guildId, target.id);

        return { type: 'success' as const, stolen, victimId: target.id, lockpickUsed, maskUsed, safePartial: victimHasSafe && safeMode === 'partial' };
      } else {
        // Провал — штраф (с fresh read для защиты от отрицательного баланса)
        const failWanted = !maskUsed && secureRandomFloat() < 0.5;
        const chargedFine = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${robberProfile.id} FOR UPDATE`;
          const freshRobber = await tx.economyProfile.findUnique({
            where: { id: robberProfile.id },
          });
          if (!freshRobber) throw new Error('no_profile');

          // Штраф не больше того, что есть в кошельке
          const actualFine = Math.min(fineAmount, freshRobber.wallet);

          await applyWalletDeltaInTransaction(
            tx,
            guildId,
            robberId,
            -actualFine,
            TX.ROB_FINE,
            i18n.t('economy.cmd.rob.tx_fine', locale, { target: target.id }),
            target.id,
          );
          await tx.economyProfile.update({
            where: { id: robberProfile.id },
            data: { lastRob: new Date() },
          });
          if (wantedOn && failWanted) {
            await createDeferredWantedClaimInTransaction(
              tx,
              `rob-fail:${guildId}:${robberId}:${interaction.id}`,
              guildId,
              robberId,
              wantedStars,
              wantedDecayMs,
              new Date(Date.now() + 300_000),
            );
          }
          return actualFine;
        });

        await invalidateProfileCache(guildId, robberId);

        // Провал: 50% шанс что полиция всё-таки засекла → +1 звезда
        // Если использована маска, полиция нас не найдет.
        return { type: 'fail' as const, fine: chargedFine, victimId: target.id, failWanted, maskUsed };
      }
    });

    if (result === null) {
      await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      return;
    }

    switch (result.type) {
      case 'cooldown':
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.rob.cooldown_name', locale), result.remaining, locale)],
          ephemeral: true,
        });
        return;

      case 'poor_victim':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.rob.error_poor_victim', locale, { userId: target.id, minWallet: fmt(result.minWallet) }))],
          ephemeral: true,
        });
        return;

      case 'poor_robber':
        await interaction.reply({
          embeds: [ecoError(i18n.t('economy.cmd.rob.error_poor_robber', locale, { fine: fmt(result.fine) }))],
          ephemeral: true,
        });
        return;

      case 'safe_immune': {
        const phrase = pickPhrase('economy.cmd.rob.phrase_safe_protected', locale, {
          robber: `<@${robberId}>`,
          victim: `<@${target.id}>`,
        });
        await interaction.reply({
          embeds: [ecoError(phrase)],
          ephemeral: true,
        });
        return;
      }

      case 'success': {
        const extras: string[] = [];
        if (result.lockpickUsed) {
          extras.push(pickPhrase('economy.cmd.rob.phrase_lockpick_used', locale));
        }
        if (result.safePartial) {
          extras.push(pickPhrase('economy.cmd.rob.phrase_safe_partial', locale));
        }
        // Wanted-звезда грабителю (всегда при success)
        // config уже загружен выше — не делаем лишний запрос к БД
        const wantedConfig = config;
        const wantedOn = wantedConfig?.wantedEnabled !== false;

        if (result.maskUsed) {
          extras.push(`🎭 **Скрытность:** ваше имя не попадёт в новости, и вы не получите звезду розыска!`);
        } else if (wantedOn) {
          extras.push(`${EMOJI.WANTED} **Свидетели запомнили ваше лицо!** Ориентировка будет передана полиции через 5 минут. Поторопитесь отмыть деньги или скрыться!`);
        }

        const robberDisplay = result.maskUsed ? 'Неизвестный в маске' : interaction.user.displayName;
        const embed = new BublikEmbed()
          .setColor(0x2ecc71)
          .setAuthor({
            name: i18n.t('economy.cmd.rob.embed_author', locale, { user: robberDisplay }),
            iconURL: result.maskUsed ? undefined : interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setDescription(
            `${EMOJI.ROB} ${i18n.t('economy.cmd.rob.embed_success', locale, { victim: `<@${result.victimId}>` })}\n\n` +
            `${EMOJI.SHEKEL} ${i18n.t('economy.cmd.rob.embed_success_stolen', locale, { amount: fmt(result.stolen) })}\n` +
            `${EMOJI.SUCCESS} ${i18n.t('economy.cmd.rob.embed_success_detail', locale)}` +
            (extras.length > 0 ? `\n\n${extras.join('\n')}` : ''),
          );
        await interaction.reply({ embeds: [embed] });

        // Отправка новостей и начисление розыска с задержкой 5 минут
        if (result.maskUsed) {
          const newsRobberId = 'Неизвестный в маске';
          await newsRobSuccess(client, guildId, newsRobberId, result.victimId, result.stolen, locale).catch(() => {});
        } else {
          setTimeout(async () => {
            try {
              if (!isGuildAllowed(guildId)) return;
              await newsRobSuccess(client, guildId, robberId, result.victimId, result.stolen, locale).catch(() => {});
            } catch (err) {
              log.error('Error in delayed rob report', err);
            }
          }, 300_000);
        }

        return;
      }

      case 'fail': {
        const wantedConfig = config; // config уже загружен выше
        const wantedOn = wantedConfig?.wantedEnabled !== false;
        const gotStar = wantedOn && result.failWanted && !result.maskUsed;
        let extra = '';
        if (result.maskUsed) {
          extra = `\n\n🎭 **Скрытность:** маска порвалась, но ваше лицо никто не заметил.`;
        } else if (gotStar) {
          extra = `\n\n${EMOJI.WANTED} **Вас чуть не поймали!** Жертва сообщает ваши приметы полиции. Звезда розыска будет выдана через 5 минут!`;
        }
        const robberDisplay = result.maskUsed ? 'Неизвестный в маске' : interaction.user.displayName;
        const embed = new BublikEmbed()
          .setColor(0xe74c3c)
          .setAuthor({
            name: i18n.t('economy.cmd.rob.embed_author', locale, { user: robberDisplay }),
            iconURL: result.maskUsed ? undefined : interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setDescription(
            `${EMOJI.ROB} ${i18n.t('economy.cmd.rob.embed_fail', locale, { victim: `<@${result.victimId}>` })}\n\n` +
            `${EMOJI.DOWN} ${i18n.t('economy.cmd.rob.embed_fail_fine', locale, { amount: fmt(result.fine) })}\n` +
            `${EMOJI.ERROR} ${i18n.t('economy.cmd.rob.embed_fail_detail', locale)}` + extra,
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
    }
  },
};

export default robCommand;
