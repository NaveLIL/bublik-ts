import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types/Command';
import { getDatabase } from '../../../core/Database';
import { getEcoConfig, getOrCreateProfile } from '../database';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { ecoError, ecoSuccess } from '../embeds';
import { fmt } from '../profile';

const governmentCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('government')
    .setDescription('Управление и казна города Неве-Эрез')
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Посмотреть баланс казны, налоги и стабильность города'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('transactions')
        .setDescription('Просмотреть последние 10 транзакций казны (только для мэрии и админов)'),
    ),

  scope: CommandScope.Guild,
  category: 'economy',
  descriptionKey: 'commands.government.description',

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    const config = await getEcoConfig(guildId);
    if (!config?.enabled) {
      await interaction.reply({
        embeds: [ecoError('❌ Система экономики выключена на этом сервере!')],
        ephemeral: true,
      });
      return;
    }

    const govProfile = await getOrCreateProfile(guildId, 'government');

    if (sub === 'status') {
      // Вычислим стабильность
      let stabilityColor = 0x2ecc71; // Зеленый
      let stabilityText = '🟢 **Стабильное** (полные выплаты `/daily` и `/weekly` гарантированы)';
      if (govProfile.wallet <= 0) {
        stabilityColor = 0xe74c3c; // Красный
        stabilityText = '🔴 **Кризис** (выплаты пособий остановлены из-за отсутствия средств!)';
      } else if (govProfile.wallet < 5000) {
        stabilityColor = 0xe67e22; // Оранжевый
        stabilityText = '🟡 **Дефицит бюджета** (выплаты могут выдаваться частично)';
      }

      // Выведем ставки
      const taxLaunder = config.dirtyLaunderTax ?? 15;
      const taxWithdraw = config.bankWithdrawTax ?? 2;
      const taxTransfer = config.transferTax ?? 5;

      const embed = new BublikEmbed()
        .setColor(stabilityColor)
        .setTitle('🏛️ Мэрия г. Неве-Эрез')
        .setDescription(
          `Добро пожаловать в городскую ратушу! Здесь вы можете ознакомиться с финансовым положением города.\n\n` +
          `💰 **Бюджет казны:** **${fmt(govProfile.wallet)} ₪**\n` +
          `📈 **Состояние экономики:** ${stabilityText}\n\n` +
          `💼 **Действующие налоги и пошлины:**\n` +
          `• Налог на банковские переводы (\`/pay\`): **${taxTransfer}%**\n` +
          `• Пошлина за снятие наличных в банке: **${taxWithdraw}%**\n` +
          `• Пошлина за легализацию доходов (\`/launder\`): **${taxLaunder}%**\n` +
          `• Штраф за бродяжничество на площади (\`/beg\`): **200 ₪**\n\n` +
          `👮 **Правопорядок:**\n` +
          `• Шериф / Полиция: ${config.policeRoleId ? `<@&${config.policeRoleId}>` : '*не назначена*'}\n` +
          `• Сотрудники Мэрии: ${config.govStaffRoleId ? `<@&${config.govStaffRoleId}>` : '*не назначены*'}`,
        );

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'transactions') {
      const member = interaction.member as GuildMember;
      const isAdmin = member.permissions.has('Administrator');
      const isStaff = config.govStaffRoleId ? member.roles.cache.has(config.govStaffRoleId) : false;

      if (!isAdmin && !isStaff) {
        await interaction.reply({
          embeds: [ecoError('❌ Данная информация является государственной тайной и доступна только сотрудникам Мэрии!')],
          ephemeral: true,
        });
        return;
      }

      const db = getDatabase();
      const txs = await db.economyTransaction.findMany({
        where: { guildId, userId: 'government' },
        take: 10,
        orderBy: { createdAt: 'desc' },
      });

      if (txs.length === 0) {
        await interaction.reply({
          embeds: [ecoSuccess('🏛️ История транзакций казны пуста.')],
          ephemeral: true,
        });
        return;
      }

      const embed = new BublikEmbed()
        .setColor(0x34495e)
        .setTitle('📊 Выписка по счёту Казны г. Неве-Эрез')
        .setDescription(
          `Последние 10 бюджетных транзакций:\n\n` +
          txs
            .map((t) => {
              const sign = t.amount > 0 ? '➕' : '➖';
              const time = `<t:${Math.floor(t.createdAt.getTime() / 1000)}:R>`;
              return `• [${time}] **${sign} ${fmt(Math.abs(t.amount))} ₪**\n  *${t.details || t.type}* (Баланс: ${fmt(t.balance)} ₪)`;
            })
            .join('\n\n'),
        );

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};

export default governmentCommand;
