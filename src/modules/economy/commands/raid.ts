import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { successEmbed, errorEmbed } from '../../../core/EmbedBuilder';
import { i18n } from '../../../core/I18n';
import { getGuildLocale } from '../../../core/GuildConfig';
import { getOrCreatePendingRaid, getEcoConfig } from '../database';
import { startRaidForGuild, drainAllLeftUsers } from '../raid';
import { getDatabase } from '../../../core/Database';

const raidCommand: BublikCommand = {
  category: 'economy',
  descriptionKey: 'economy.cmd.raid.description',
  scope: CommandScope.Guild,
  data: new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Управление штурмом заброшенных сейфов')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('force')
        .setDescription('Принудительно начать штурм сейфа на этом сервере'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Показать текущий джекпот и список ушедших игроков'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('pb_notify')
        .setDescription('Разослать участникам ПБ уведомление об их текущем тире (один раз)'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        embeds: [errorEmbed('⛔ Эта команда доступна только администраторам сервера.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const locale = await getGuildLocale(guildId);

    if (subcommand === 'force') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Сначала принудительно соберем балансы ушедших участников
      await drainAllLeftUsers(interaction.client).catch(() => null);

      const started = await startRaidForGuild(interaction.client, guildId);
      if (started) {
        await interaction.editReply({
          embeds: [successEmbed(i18n.t('economy.cmd.raid.cmd_force_success', locale))],
        });
      } else {
        await interaction.editReply({
          embeds: [errorEmbed(i18n.t('economy.cmd.raid.cmd_force_fail', locale))],
        });
      }
    }

    else if (subcommand === 'stats') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const pending = await getOrCreatePendingRaid(guildId);
      const db = getDatabase();

      // Посчитаем количество будущих кандидатов на списание (кто ушел, но 14 дней еще не прошло)
      const futureCandidates = await db.leftMember.findMany({
        where: { guildId },
      });

      const config = await getEcoConfig(guildId);
      const targetChannel = config?.leaderboardChannelId
        ? `<#${config.leaderboardChannelId}>`
        : `*${i18n.t('economy.cmd.raid.stats_no_channel', locale)}*`;

      let desc = `### 💰 ${i18n.t('economy.cmd.raid.stats_jackpot', locale)}: **${pending.totalPool.toLocaleString()} ₪**\n` +
        `📢 ${i18n.t('economy.cmd.raid.stats_channel', locale)}: ${targetChannel}\n\n`;

      if (pending.abandonedAccounts && pending.abandonedAccounts.length > 0) {
        const lines = pending.abandonedAccounts.map((a: any) =>
          `> 👤 <@${a.userId}> — **${a.balance.toLocaleString()} ₪**`
        );
        desc += `**💼 ${i18n.t('economy.cmd.raid.stats_drained_list', locale)}**:\n` + lines.join('\n') + '\n\n';
      }

      if (futureCandidates.length > 0) {
        const lines = futureCandidates.map((c: any) => {
          const timeLeft = Math.max(0, (c.leftAt.getTime() + 14 * 24 * 60 * 60 * 1000) - Date.now());
          const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
          return `> 👤 <@${c.userId}> (выход ${c.leftAt.toLocaleDateString()}, списание через ~${daysLeft} д.)`;
        });
        desc += `**⏳ ${i18n.t('economy.cmd.raid.stats_future_list', locale)}**:\n` + lines.join('\n');
      } else {
        desc += `*${i18n.t('economy.cmd.raid.stats_no_future', locale)}*`;
      }

      const embed = successEmbed(desc)
        .setTitle(`🛡️ ${i18n.t('economy.cmd.raid.stats_title', locale)}`);

      await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'pb_notify') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const { syncAllGuildsPbTiers } = require('../voice-tracker');
      await syncAllGuildsPbTiers(interaction.client).catch(() => null);

      const db = getDatabase();
      const config = await getEcoConfig(guildId);
      const pbRoleIds: string[] = config?.pbRoleIds ?? [];

      const { PB_TIERS } = require('../constants');

      // Находим все профили, у которых есть накопленное ПБ-время
      const profiles = await db.economyProfile.findMany({
        where: {
          guildId,
          pbVoiceSeconds: { gt: 0 }
        }
      });

      if (profiles.length === 0) {
        await interaction.editReply({
          embeds: [errorEmbed(i18n.t('economy.pb_tier.notify_err_no_users', locale))]
        });
        return;
      }

      await interaction.guild?.members.fetch().catch(() => null);

      let successCount = 0;
      for (const p of profiles) {
        const member = interaction.guild?.members.cache.get(p.userId);
        if (!member || member.user.bot) continue;

        const hours = Math.floor(p.pbVoiceSeconds / 3600);

        // Находим текущий заработанный тир-роль ПБ
        let earnedRoleId: string | null = null;
        let targetIdx = -1;
        for (let i = 0; i < pbRoleIds.length && i < PB_TIERS.length; i++) {
          const roleId = pbRoleIds[i];
          const hoursNeeded = PB_TIERS[i].hours;
          if (hours >= hoursNeeded && i > targetIdx) {
            earnedRoleId = roleId;
            targetIdx = i;
          }
        }

        let roleName = i18n.t('economy.pb_tier.dm_info_no_role', locale);
        let multiplier = '1.0';
        if (earnedRoleId) {
          const role = interaction.guild?.roles.cache.get(earnedRoleId);
          if (role) {
            roleName = role.name;
            multiplier = String(PB_TIERS[targetIdx].multiplier);
          }
        }

        try {
          const embed = successEmbed(
            i18n.t('economy.pb_tier.dm_info_desc', locale, {
              hours: String(hours),
              role: roleName,
              multiplier
            })
          ).setTitle(`🎖️ ${i18n.t('economy.pb_tier.dm_info_title', locale)}`);

          await member.send({ embeds: [embed] });
          successCount++;
          // Пауза 200мс между отправками для защиты от лимитов Discord
          await new Promise(r => setTimeout(r, 200));
        } catch {
          // Игрок мог закрыть личные сообщения
        }
      }

      await interaction.editReply({
        embeds: [successEmbed(i18n.t('economy.pb_tier.notify_success', locale, { count: String(successCount) }))]
      });
    }
  },
};

export default raidCommand;
export { raidCommand };
