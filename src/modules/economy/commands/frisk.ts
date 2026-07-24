import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError } from '../embeds';
import { fmt } from '../profile';
import { EMOJI } from '../constants';
import { getFriskDenied, isConfiguredEconomyOwner } from '../ownerImmunity';

const friskCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('frisk')
    .setDescription('👮 Обыскать гражданина на наличие розыска, грязных денег или улик (только для полиции)')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Гражданин для досмотра')
        .setRequired(true),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.frisk.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const officerId = interaction.user.id;
    const target = interaction.options.getUser('user', true);

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({
        embeds: [ecoError('❌ Система экономики выключена на этом сервере!')],
        ephemeral: true,
      });
      return;
    }

    // Проверяем, что досматривает именно полицейский
    const member = interaction.member as GuildMember;
    const isPolice = config.policeRoleId ? member.roles.cache.has(config.policeRoleId) : false;
    if (!isPolice) {
      await interaction.reply({
        embeds: [ecoError('👮 Досмотр могут проводить только сотрудники полиции при исполнении!')],
        ephemeral: true,
      });
      return;
    }

    if (target.bot) {
      await interaction.reply({
        embeds: [ecoError('❌ Вы не можете обыскать бота!')],
        ephemeral: true,
      });
      return;
    }

    if (target.id === officerId) {
      await interaction.reply({
        embeds: [ecoError('❌ Вы не можете обыскать самого себя!')],
        ephemeral: true,
      });
      return;
    }

    if (isConfiguredEconomyOwner(target.id)) {
      await interaction.reply({
        embeds: [ecoError(getFriskDenied())],
        ephemeral: true,
      });
      return;
    }

    const targetProfile = await getOrCreateProfile(guildId, target.id);
    const targetMember = await interaction.guild!.members.fetch(target.id).catch(() => null);

    const isTargetPolice = config.policeRoleId && targetMember ? targetMember.roles.cache.has(config.policeRoleId) : false;
    if (isTargetPolice) {
      await interaction.reply({
        embeds: [ecoError('❌ Вы не можете обыскать другого сотрудника полиции!')],
        ephemeral: true,
      });
      return;
    }

    const dirty = targetProfile.dirtyAmount ?? 0;
    const stars = targetProfile.wantedStars ?? 0;
    const hasLockpick = targetProfile.lockpickReady ?? false;
    const hasMask = targetProfile.maskReady ?? false;
    const hasSafe = targetProfile.safeUntil && new Date(targetProfile.safeUntil).getTime() > Date.now();

    // Формируем отчет о досмотре
    const lines: string[] = [];
    let suspicious = false;

    // Розыск
    if (stars > 0) {
      suspicious = true;
      lines.push(`${EMOJI.STAR} **Уровень розыска:** ⭐ **${stars}**`);
    } else {
      lines.push(`${EMOJI.STAR} **Уровень розыска:** нет`);
    }

    // Грязные деньги
    if (dirty > 0) {
      suspicious = true;
      lines.push(`💸 **Грязные наличные:** **${fmt(dirty)} ₪**`);
    } else {
      lines.push(`💸 **Грязные наличные:** нет`);
    }

    // Улики / Предметы
    const items: string[] = [];
    if (hasLockpick) {
      suspicious = true;
      items.push('🔒 Отмычка для взлома сейфов');
    }
    if (hasMask) {
      suspicious = true;
      items.push('🎭 Маска скрытия лица (балаклава)');
    }

    if (items.length > 0) {
      lines.push(`🎒 **Подозрительные предметы:**\n` + items.map((it) => `  • ${it}`).join('\n'));
    } else {
      lines.push(`🎒 **Подозрительные предметы:** чист`);
    }

    // Сейф
    lines.push(`🛡️ **Сейф в банке:** ${hasSafe ? '🟢 Активен' : '🔴 Отсутствует'}`);

    const embed = new BublikEmbed()
      .setColor(suspicious ? 0xe74c3c : 0x2ecc71)
      .setAuthor({
        name: `Досмотр гражданина: ${target.displayName}`,
        iconURL: target.displayAvatarURL({ size: 64 }),
      })
      .setDescription(
        `👮 **Офицер <@${officerId}> провёл личный обыск гражданина <@${target.id}>.**\n\n` +
        `📊 **Результаты осмотра:**\n` +
        lines.join('\n\n') +
        `\n\n` +
        (suspicious
          ? `🚨 **Вердикт:** Обнаружены подозрительные улики / признаки состава преступления!`
          : `🟢 **Вердикт:** Подозрительных улик не обнаружено, гражданин чист перед законом.`)
      );

    await interaction.reply({ embeds: [embed] });
  },
};

export default friskCommand;
