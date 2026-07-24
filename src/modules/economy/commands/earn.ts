// ═══════════════════════════════════════════════
//  /daily, /weekly, /work, /crime, /beg
//
//  Команды заработка шекелей.
//  Каждая команда — отдельный BublikCommand,
//  все экспортируются массивом.
// ═══════════════════════════════════════════════

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ComponentType,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { isGuildAllowed } from '../../../core/Whitelist';
import { getEcoConfig, getPbRoleIds, invalidateProfileCache } from '../database';
import { applyWalletDeltaInTransaction, withFinancialLock, checkCooldown, fmt, addToWallet } from '../profile';
import { getDatabase } from '../../../core/Database';
import { COOLDOWNS, TX } from '../constants';
import {
  claimDaily,
  claimWeekly,
  doWork,
  doCrime,
} from '../earnings';
import {
  buildDailyEmbed,
  buildWeeklyEmbed,
  buildWorkEmbed,
  buildCrimeEmbed,
  buildCooldownEmbed,
  ecoError,
  ecoLocked,
} from '../embeds';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { newsEarning, newsStreak, newsCrimeJackpot, newsMilestone } from '../news';
import { getOrCreateProfile } from '../database';
import { canProcessEconomyCollector, registerEconomyCollector } from '../collector-lifecycle';

const log = logger.child('Economy:Earn');

// ── Утилита: проверка enabled ─────────────────

async function checkEnabled(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  locale: string,
): Promise<boolean> {
  const config = await getEcoConfig(guildId);
  if (!config?.enabled) {
    await interaction.reply({
      embeds: [ecoError(i18n.t('economy.common.error_economy_disabled', locale))],
      ephemeral: true,
    });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════
//  /daily
// ═══════════════════════════════════════════════

const dailyCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Получить ежедневную награду в шекелях'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.daily.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    if (!(await checkEnabled(interaction, guildId, locale))) return;

    const member = interaction.member as GuildMember;
    const result = await claimDaily(guildId, member, await getPbRoleIds(guildId), locale);

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.daily.cooldown_name', locale), result.cooldownRemaining!, locale)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.daily.error_default', locale))], ephemeral: true });
      }
      return;
    }

    const embed = buildDailyEmbed(result, member, locale);
    if (result.treasuryState === 'dry') {
      embed.setColor(0xe74c3c);
      embed.setDescription(
        `⚠️ **Кризис в казне г. Неве-Эрез!**\n` +
        `Баланс государственной казны равен **0 ₪**.\n` +
        `Вы не получили пособие по безработице.\n\n` +
        `*Сыграйте в казино, переводите деньги или совершайте преступления, чтобы пополнить бюджет города!*`
      );
    } else if (result.treasuryState === 'partial') {
      embed.setColor(0xe67e22);
      embed.setDescription(
        `⚠️ **Дефицит бюджета в казне г. Неве-Эрез!**\n` +
        `В казне было недостаточно средств, чтобы выплатить вам полную сумму в **${fmt(result.expectedAmount ?? 0)} ₪**.\n` +
        `Государство выплатило всё, что осталось: **${fmt(result.amount)} ₪**.\n\n` +
        (result.salary && result.salary > 0 ? `💼 **Государственный оклад (сокращённый):** +${fmt(result.salary)} ₪\n\n` : '') +
        embed.data.description
      );
    } else {
      if (result.salary && result.salary > 0) {
        embed.setDescription(
          `💼 **Государственный оклад:** +${fmt(result.salary)} ₪\n\n` +
          embed.data.description
        );
      }
    }

    await interaction.reply({ embeds: [embed] });

    // Новости: крупный заработок
    if (result.amount > 0) {
      await newsEarning(client, guildId, member.id, 'earn_daily', result.amount, locale).catch(() => {});
    }

    // Новости: стрик
    if (result.streak) {
      await newsStreak(client, guildId, member.id, result.streak, locale).catch(() => {});
    }

    // Новости: milestone
    const profile = await getOrCreateProfile(guildId, member.id);
    const totalBalance = profile.wallet + profile.bank;
    await newsMilestone(client, guildId, member.id, totalBalance, locale).catch(() => {});
  },
};

// ═══════════════════════════════════════════════
//  /weekly
// ═══════════════════════════════════════════════

const weeklyCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('weekly')
    .setDescription('Получить еженедельный бонус в шекелях'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.weekly.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    if (!(await checkEnabled(interaction, guildId, locale))) return;

    const member = interaction.member as GuildMember;

    // Fail closed until RegBattle writes a durable per-user attendance ledger.
    // Current roles, cumulative PB-channel time and TeamSession rows do not
    // prove that this user completed an eligible PB session in the last 7 days.
    const playedThisWeek = false;

    const result = await claimWeekly(guildId, member, await getPbRoleIds(guildId), playedThisWeek, locale);

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.weekly.cooldown_name', locale), result.cooldownRemaining!, locale)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.weekly.error_default', locale))], ephemeral: true });
      }
      return;
    }

    const embed = buildWeeklyEmbed(result, member, locale);
    if (result.treasuryState === 'dry') {
      embed.setColor(0xe74c3c);
      embed.setDescription(
        `⚠️ **Кризис в казне г. Неве-Эрез!**\n` +
        `Баланс государственной казны равен **0 ₪**.\n` +
        `Еженедельная социальная выплата не выдана.\n\n` +
        `*Помогите наполнить казну города через налоги, казино или штрафы!*`
      );
    } else if (result.treasuryState === 'partial') {
      embed.setColor(0xe67e22);
      embed.setDescription(
        `⚠️ **Дефицит бюджета в казне г. Неве-Эрез!**\n` +
        `В казне было недостаточно средств для полной выплаты в **${fmt(result.expectedAmount ?? 0)} ₪**.\n` +
        `Выплачен весь остаток казны: **${fmt(result.amount)} ₪**.\n\n` +
        embed.data.description
      );
    }

    await interaction.reply({ embeds: [embed] });
    if (result.amount > 0) {
      await newsEarning(client, guildId, member.id, 'earn_weekly', result.amount, locale).catch(() => {});
    }
  },
};

// ═══════════════════════════════════════════════
//  /work
// ═══════════════════════════════════════════════

const workCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Поработать и заработать шекели'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.work.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    if (!(await checkEnabled(interaction, guildId, locale))) return;

    const member = interaction.member as GuildMember;
    const result = await doWork(guildId, member, await getPbRoleIds(guildId), locale);

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.work.cooldown_name', locale), result.cooldownRemaining!, locale)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.work.error_default', locale))], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildWorkEmbed(result, member, locale)] });
    await newsEarning(client, guildId, member.id, 'earn_work', result.amount, locale).catch(() => {});
  },
};

// ═══════════════════════════════════════════════
//  /crime
// ═══════════════════════════════════════════════

const crimeCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('crime')
    .setDescription('Совершить преступление (риск потерять шекели!)'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.crime.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(interaction.guildId);
    if (!(await checkEnabled(interaction, guildId, locale))) return;

    const member = interaction.member as GuildMember;
    const config = await getEcoConfig(guildId);
    const isPolice = config?.policeRoleId ? member.roles.cache.has(config.policeRoleId) : false;
    if (isPolice) {
      await interaction.reply({
        embeds: [ecoError('👮 **Служитель закона не может нарушать общественный порядок!**\nПолицейским запрещено совершать преступления.')],
        ephemeral: true,
      });
      return;
    }

    const result = await doCrime(
      guildId,
      member,
      await getPbRoleIds(guildId),
      locale,
      `crime:${guildId}:${member.id}:${interaction.id}`,
    );

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed(i18n.t('economy.cmd.crime.cooldown_name', locale), result.cooldownRemaining!, locale)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked(locale)], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError(i18n.t('economy.cmd.crime.error_default', locale))], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildCrimeEmbed(result, member, locale)] });

    // Сообщение о розыске или о том, что маска спасла от звезды
    if (result.success && result.amount > 0) {
      if (result.maskUsed) {
        await interaction.followUp({
          embeds: [ecoError(`🎭 **Маска скрыла ваше лицо!** Камеры наблюдения не смогли вас распознать. Вы избежали розыска.`)],
          ephemeral: true,
        }).catch(() => {});

        // Новость о крупном заработке выходит сразу, т.к. лицо скрыто
        if (result.amount > 0) {
          await newsCrimeJackpot(client, guildId, member.id, result.amount, `Неизвестный в маске: ${result.details || ''}`, locale).catch(() => {});
        }
      } else if (result.wantedAdded) {
        await interaction.followUp({
          embeds: [ecoError(`⭐ **Камеры зафиксировали преступление!** Полиция опознает ваше лицо через 5 минут. Успейте скрыться или отмыть грязные деньги!`)],
          ephemeral: true,
        }).catch(() => {});

        // Новость — best effort; wanted-состояние применяет durable scheduler.
        setTimeout(async () => {
          try {
            if (!isGuildAllowed(guildId)) return;
            if (result.amount > 0) {
              await newsCrimeJackpot(client, guildId, member.id, result.amount, result.details || '', locale).catch(() => {});
            }
          } catch (err) {
            log.error('Error in delayed crime report', err);
          }
        }, 300_000);
      } else {
        // Если преступление прошло успешно и без звезд
        if (result.amount > 0) {
          await newsCrimeJackpot(client, guildId, member.id, result.amount, result.details || '', locale).catch(() => {});
        }
      }
    }
  },
};

// ═══════════════════════════════════════════════
//  /beg
// ═══════════════════════════════════════════════

const begCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('beg')
    .setDescription('Поставить чашку для милостыни на городской площади'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.beg.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const beggarId = interaction.user.id;
    const locale = await getGuildLocale(interaction.guildId);
    if (!(await checkEnabled(interaction, guildId, locale))) return;

    const config = await getEcoConfig(guildId);
    const cooldownMs = config ? Number(config.begCooldown) : COOLDOWNS.beg;

    // Сначала проверим кулдаун в базе данных ( lastBeg )
    const profile = await getOrCreateProfile(guildId, beggarId);
    const remaining = checkCooldown(profile.lastBeg, cooldownMs);
    if (remaining > 0) {
      await interaction.reply({
        embeds: [buildCooldownEmbed(i18n.t('economy.cmd.beg.cooldown_name', locale), remaining, locale)],
        ephemeral: true,
      });
      return;
    }

    // Ставим время начала попрошайничества в базу, чтобы игрок не спамил новые чашки
    const db = getDatabase();
    await db.economyProfile.update({
      where: { guildId_userId: { guildId, userId: beggarId } },
      data: { lastBeg: new Date() },
    });
    await invalidateProfileCache(guildId, beggarId);

    let totalCollected = 0;
    const donors = new Map<string, number>();

    const buildBegEmbed = (finished = false, kickedBy: string | null = null): BublikEmbed => {
      const embed = new BublikEmbed();

      if (kickedBy) {
        embed
          .setColor(0xe74c3c)
          .setTitle(`🚨 Бродяжничество пресечено!`)
          .setDescription(
            `👮 **Полиция навела порядок на площади!**\n` +
            `Офицер <@${kickedBy}> прогнал <@${beggarId}> и выписал ему штраф в размере **200 ₪**.\n\n` +
            `💰 **Успел собрать:** **${fmt(totalCollected)}**`
          );
      } else if (finished) {
        embed
          .setColor(0x2ecc71)
          .setTitle(`🧺 Попрошайничество завершено`)
          .setDescription(
            `<@${beggarId}> забрал свою чашку с площади и пошёл домой.\n\n` +
            `💰 **Всего собрано:** **${fmt(totalCollected)}**\n` +
            `👥 **Щедрые граждане:**\n` +
            (donors.size > 0
              ? Array.from(donors.entries()).map(([id, sum]) => `• <@${id}> — **${fmt(sum)}**`).join('\n')
              : '*никто не подал...*')
          );
      } else {
        embed
          .setColor(0x3498db)
          .setTitle(`🧺 Площадь г. Эрез`)
          .setDescription(
            `<@${beggarId}> сел на углу улицы, протянул руку и поставил чашку для милостыни...\n\n` +
            `💰 **Собрано шекелей:** **${fmt(totalCollected)}**\n\n` +
            `👥 **Кто помог:**\n` +
            (donors.size > 0
              ? Array.from(donors.entries()).map(([id, sum]) => `• <@${id}> — **${fmt(sum)}**`).join('\n')
              : '*пусто. Будьте милосердны, бросьте монетку!*')
          );
      }
      return embed;
    };

    const getButtons = (disabled = false): ActionRowBuilder<ButtonBuilder> => {
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('beg_give_10')
          .setLabel('🪙 Подать 10 ₪')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('beg_give_50')
          .setLabel('🪙 Подать 50 ₪')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('beg_give_100')
          .setLabel('🪙 Подать 100 ₪')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('beg_kick')
          .setLabel('👮 Прогнать')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled),
      );
    };

    const response = await interaction.reply({
      embeds: [buildBegEmbed()],
      components: [getButtons()],
      fetchReply: true,
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 180_000, // Активно 3 минуты
    });
    registerEconomyCollector(collector);

    collector.on('collect', async (i) => {
      if (!canProcessEconomyCollector(guildId)) {
        collector.stop('guild_not_allowed');
        await i.reply({ content: '⛔ Этот сервер больше не авторизован.', ephemeral: true }).catch(() => {});
        return;
      }
      const action = i.customId;

      if (action === 'beg_kick') {
        const member = i.member as GuildMember;
        const isPolice = config?.policeRoleId ? member.roles.cache.has(config.policeRoleId) : false;

        if (!isPolice) {
          await i.reply({
            content: '❌ Только сотрудники полиции могут прогонять попрошаек!',
            ephemeral: true,
          });
          return;
        }

        // Штраф попрошайке
        const fineAmount = 200;
        await withFinancialLock(guildId, beggarId, async () => {
          const freshBeggar = await getOrCreateProfile(guildId, beggarId);
          const actualFine = Math.min(fineAmount, freshBeggar.wallet);
          await addToWallet(guildId, beggarId, -actualFine, TX.CRIME_FINE, `КПЗ: бродяжничество (штраф от ${i.user.id})`);
        });

        collector.stop(`kicked_by_${i.user.id}`);
        return;
      }

      // Пожертвование
      if (action.startsWith('beg_give_')) {
        const donorId = i.user.id;
        if (donorId === beggarId) {
          await i.reply({
            content: '❌ Вы не можете подать шекели самому себе!',
            ephemeral: true,
          });
          return;
        }

        const amountToGive = parseInt(action.split('_').pop()!, 10);

        // Проверяем баланс донора
        const donorProfile = await getOrCreateProfile(guildId, donorId);
        if (donorProfile.wallet < amountToGive) {
          await i.reply({
            content: `❌ У вас недостаточно шекелей в кошельке! Ваш баланс: **${fmt(donorProfile.wallet)} ₪**`,
            ephemeral: true,
          });
          return;
        }

        // Выполняем транзакцию списания у донора и начисления попрошайке
        const success = await withFinancialLock(guildId, donorId, async () => {
          try {
            await db.$transaction(async (tx) => {
              const donor = await tx.economyProfile.findUniqueOrThrow({
                where: { guildId_userId: { guildId, userId: donorId } },
              });
              const beggar = await tx.economyProfile.findUniqueOrThrow({
                where: { guildId_userId: { guildId, userId: beggarId } },
              });
              // Детерминированный порядок row-lock защищает встречные переводы
              // от deadlock. Грязные деньги нельзя легализовать пожертвованием.
              for (const id of [donor.id, beggar.id].sort()) {
                await tx.$queryRaw`SELECT "id" FROM "economy_profiles" WHERE "id" = ${id} FOR UPDATE`;
              }
              const freshDonor = await tx.economyProfile.findUniqueOrThrow({ where: { id: donor.id } });
              if (freshDonor.wallet - freshDonor.dirtyAmount < amountToGive) {
                throw new Error('dirty_or_insufficient');
              }
              await applyWalletDeltaInTransaction(
                tx, guildId, donorId, -amountToGive, 'beg_give',
                `Подал милостыню для <@${beggarId}>`, beggarId,
              );
              await applyWalletDeltaInTransaction(
                tx, guildId, beggarId, amountToGive, 'beg_receive',
                `Получил подаяние от <@${donorId}>`, donorId,
              );
            });
            await invalidateProfileCache(guildId, donorId);
            await invalidateProfileCache(guildId, beggarId);
            return true;
          } catch (err: any) {
            if (err?.message === 'dirty_or_insufficient' || err?.message === 'insufficient_funds') return false;
            throw err;
          }
        });

        if (!success) {
          await i.reply({
            content: '❌ Не удалось провести транзакцию.',
            ephemeral: true,
          });
          return;
        }

        // Обновляем статистику сбора
        totalCollected += amountToGive;
        donors.set(donorId, (donors.get(donorId) ?? 0) + amountToGive);

        // Обновляем embed в сообщении
        await i.update({
          embeds: [buildBegEmbed()],
        });
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'module_unload' || !canProcessEconomyCollector(guildId)) return;
      try {
        if (reason.startsWith('kicked_by_')) {
          const kickedBy = reason.replace('kicked_by_', '');
          await interaction.editReply({
            embeds: [buildBegEmbed(true, kickedBy)],
            components: [],
          }).catch(() => {});
        } else {
          await interaction.editReply({
            embeds: [buildBegEmbed(true)],
            components: [],
          }).catch(() => {});
        }
      } catch (err) {
        log.debug('Не удалось закрыть beg-панель', { error: String(err) });
      }
    });
  },
};

export { dailyCommand, weeklyCommand, workCommand, crimeCommand, begCommand };
