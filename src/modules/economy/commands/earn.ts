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
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { logger } from '../../../core/Logger';
import { getEcoConfig, getPbRoleIds } from '../database';
import {
  claimDaily,
  claimWeekly,
  doWork,
  doCrime,
  doBeg,
} from '../earnings';
import {
  buildDailyEmbed,
  buildWeeklyEmbed,
  buildWorkEmbed,
  buildCrimeEmbed,
  buildBegEmbed,
  buildCooldownEmbed,
  ecoError,
  ecoLocked,
} from '../embeds';
import { newsEarning, newsStreak, newsCrimeJackpot, newsMilestone } from '../news';
import { getOrCreateProfile } from '../database';

const log = logger.child('Economy:Earn');

// ── Утилита: проверка enabled ─────────────────

async function checkEnabled(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<boolean> {
  const config = await getEcoConfig(guildId);
  if (!config?.enabled) {
    await interaction.reply({
      embeds: [ecoError('Экономика отключена на этом сервере.')],
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
    if (!(await checkEnabled(interaction, guildId))) return;

    const member = interaction.member as GuildMember;
    const result = await claimDaily(guildId, member, await getPbRoleIds(guildId));

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed('Дейли', result.cooldownRemaining!)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError('Ошибка выполнения.')], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildDailyEmbed(result, member)] });

    // Новости: крупный заработок
    await newsEarning(client, guildId, member.id, 'earn_daily', result.amount).catch(() => {});

    // Новости: стрик
    if (result.streak) {
      await newsStreak(client, guildId, member.id, result.streak).catch(() => {});
    }

    // Новости: milestone
    const profile = await getOrCreateProfile(guildId, member.id);
    const totalBalance = profile.wallet + profile.bank;
    await newsMilestone(client, guildId, member.id, totalBalance).catch(() => {});
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
    if (!(await checkEnabled(interaction, guildId))) return;

    const member = interaction.member as GuildMember;

    // Проверяем, играл ли пользователь ПБ на этой неделе
    // (есть ли у него роль playedToday за последние 7 дней —
    //  для простоты проверяем наличие роли прямо сейчас)
    // TODO: В будущем — проверять историю ролей через transactions
    const playedThisWeek = false; // Placeholder — будет определяться по-нормальному

    const result = await claimWeekly(guildId, member, await getPbRoleIds(guildId), playedThisWeek);

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed('Еженедельный бонус', result.cooldownRemaining!)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError('Ошибка выполнения.')], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildWeeklyEmbed(result, member)] });
    await newsEarning(client, guildId, member.id, 'earn_weekly', result.amount).catch(() => {});
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
    if (!(await checkEnabled(interaction, guildId))) return;

    const member = interaction.member as GuildMember;
    const result = await doWork(guildId, member, await getPbRoleIds(guildId));

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed('Работа', result.cooldownRemaining!)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError('Ошибка выполнения.')], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildWorkEmbed(result, member)] });
    await newsEarning(client, guildId, member.id, 'earn_work', result.amount).catch(() => {});
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
    if (!(await checkEnabled(interaction, guildId))) return;

    const member = interaction.member as GuildMember;
    const result = await doCrime(guildId, member, await getPbRoleIds(guildId));

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed('Преступление', result.cooldownRemaining!)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError('Ошибка выполнения.')], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildCrimeEmbed(result, member)] });

    // Новость о крупном crime-заработке
    if (result.amount > 0) {
      await newsCrimeJackpot(client, guildId, member.id, result.amount, result.details || '').catch(() => {});
    }
  },
};

// ═══════════════════════════════════════════════
//  /beg
// ═══════════════════════════════════════════════

const begCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('beg')
    .setDescription('Попросить подаяние'),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.beg.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await checkEnabled(interaction, guildId))) return;

    const member = interaction.member as GuildMember;
    const result = await doBeg(guildId, member, await getPbRoleIds(guildId));

    if (!result.success) {
      if (result.error === 'cooldown') {
        await interaction.reply({
          embeds: [buildCooldownEmbed('Попрошайничество', result.cooldownRemaining!)],
          ephemeral: true,
        });
      } else if (result.error === 'locked') {
        await interaction.reply({ embeds: [ecoLocked()], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [ecoError('Ошибка выполнения.')], ephemeral: true });
      }
      return;
    }

    await interaction.reply({ embeds: [buildBegEmbed(result, member)] });
  },
};

export { dailyCommand, weeklyCommand, workCommand, crimeCommand, begCommand };
