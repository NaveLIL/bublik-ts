import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  GuildMember,
} from 'discord.js';
import type { BublikClient } from '../../../bot';
import { BublikCommand, CommandScope } from '../../../types';
import { refreshGuildMinecraftStatus } from '../services/status-tracker';
import {
  buildMinecraftStatusEmbed,
  buildMinecraftLinkEmbed,
  buildMinecraftProfileEmbed,
  buildMinecraftRulesEmbed,
  buildMinecraftModpackEmbed,
  buildMinecraftVoiceEmbed,
} from '../embeds';
import {
  updateMinecraftConfig,
  getOrCreateMinecraftConfig,
  getMinecraftAccountByDiscordId,
} from '../database';
import {
  requestAccountLink,
  processConfirmLink,
  processUnlinkAccount,
  getPlayerProfile,
} from '../services/link-service';

const mcCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('mc')
    .setDescription('🎮 Команды модуля Minecraft (EREZCRAFT)')
    .setDescriptionLocalizations({
      ru: '🎮 Команды модуля Minecraft (EREZCRAFT)',
    })
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Проверить текущее состояние Minecraft-сервера')
        .setDescriptionLocalizations({ ru: 'Проверить текущее состояние Minecraft-сервера' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Привязать игровой аккаунт Minecraft к профилю Discord')
        .setDescriptionLocalizations({ ru: 'Привязать игровой аккаунт Minecraft к профилю Discord' })
        .addStringOption((opt) =>
          opt
            .setName('username')
            .setDescription('Ваш игровой ник в Minecraft')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('code')
            .setDescription('6-значный одноразовый код подтверждения')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlink')
        .setDescription('Отвязать свой игровой аккаунт Minecraft')
        .setDescriptionLocalizations({ ru: 'Отвязать свой игровой аккаунт Minecraft' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('profile')
        .setDescription('Посмотреть профиль игрока Minecraft')
        .setDescriptionLocalizations({ ru: 'Посмотреть профиль игрока Minecraft' })
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Участник Discord для проверки')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('rules')
        .setDescription('Посмотреть правила сервера EREZCRAFT')
        .setDescriptionLocalizations({ ru: 'Посмотреть правила сервера EREZCRAFT' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('modpack')
        .setDescription('Информация и прямая ссылка на модпак Create')
        .setDescriptionLocalizations({ ru: 'Информация и прямая ссылка на модпак Create' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('voice')
        .setDescription('Инструкция по настройке Simple Voice Chat')
        .setDescriptionLocalizations({ ru: 'Инструкция по настройке Simple Voice Chat' })
    )
    .addSubcommandGroup((group) =>
      group
        .setName('setup')
        .setDescription('Настройки интеграции Minecraft (Администрирование)')
        .setDescriptionLocalizations({ ru: 'Настройки интеграции Minecraft (Администрирование)' })
        .addSubcommand((sub) =>
          sub
            .setName('status-channel')
            .setDescription('Указать канал для автоматической Live статус-панели')
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setDescription('Канал для вывода постоянного статуса')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('whitelist')
            .setDescription('Включить или выключить обязательный вайтлист (по умолчанию выключен)')
            .addBooleanOption((opt) =>
              opt
                .setName('enable')
                .setDescription('Включить вайтлист?')
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('player-role')
            .setDescription('Назначить роль, выдаваемую после привязки аккаунта')
            .addRoleOption((opt) =>
              opt
                .setName('role')
                .setDescription('Роль игрока Minecraft')
                .setRequired(true)
            )
        )
    ),

  scope: CommandScope.Guild,
  category: 'general',
  descriptionKey: 'commands.mc.description',

  async execute(interaction: ChatInputCommandInteraction, client: BublikClient): Promise<void> {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const member = interaction.member as GuildMember;

    // Handle /mc rules
    if (subcommand === 'rules') {
      const embed = buildMinecraftRulesEmbed();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // Handle /mc modpack
    if (subcommand === 'modpack') {
      const embed = buildMinecraftModpackEmbed();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // Handle /mc voice
    if (subcommand === 'voice') {
      const embed = buildMinecraftVoiceEmbed();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // Handle /mc status
    if (subcommand === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const metrics = await refreshGuildMinecraftStatus(client, guildId);
      const embed = buildMinecraftStatusEmbed(metrics);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Handle /mc profile
    if (subcommand === 'profile') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      const account = await getPlayerProfile(guildId, targetUser);
      const embed = buildMinecraftProfileEmbed(targetUser, account);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Handle /mc link
    if (subcommand === 'link') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const username = interaction.options.getString('username', true).trim();
      const code = interaction.options.getString('code')?.trim();

      // Check if already linked
      const existing = await getMinecraftAccountByDiscordId(guildId, interaction.user.id);
      if (existing?.isLinked) {
        await interaction.editReply({
          content: `⚠️ Ваш аккаунт Discord уже привязан к игроку **\`${existing.minecraftUsername}\`**.\nЕсли вы хотите сменить ник, сначала используйте \`/mc unlink\`.`,
        });
        return;
      }

      // Confirm code step
      if (code) {
        const confirmResult = await processConfirmLink(guildId, member, code);
        if (!confirmResult.success) {
          let reasonText = 'Неверный код подтверждения.';
          if (confirmResult.reason === 'CODE_EXPIRED') {
            reasonText = '⏱️ Срок действия кода истёк. Сгенерируйте новый код повторным вызовом `/mc link username:<ник>`.';
          } else if (confirmResult.reason === 'NOT_FOUND') {
            reasonText = '❌ Сначала запросите код командой `/mc link username:<ник>`.';
          }
          await interaction.editReply({ content: reasonText });
          return;
        }

        await interaction.editReply({
          content: `🎉 **Успешно!** Игровой аккаунт **\`${confirmResult.account?.minecraftUsername}\`** официально привязан к вашей учетной записи Discord!`,
        });
        return;
      }

      // Code generation step
      const { code: newCode } = await requestAccountLink(guildId, interaction.user.id, username);
      const embed = buildMinecraftLinkEmbed(username, newCode);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Handle /mc unlink
    if (subcommand === 'unlink') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const success = await processUnlinkAccount(guildId, member);
      if (!success) {
        await interaction.editReply({
          content: '❌ У вас нет привязанного аккаунта Minecraft.',
        });
        return;
      }

      await interaction.editReply({
        content: '✅ Игровой аккаунт Minecraft успешно отвязан.',
      });
      return;
    }

    // Handle /mc setup group
    if (group === 'setup') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: '⛔ Только администраторы сервера могут изменять настройки модуля Minecraft.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (subcommand === 'status-channel') {
        const targetChannel = interaction.options.getChannel('channel', true);
        await updateMinecraftConfig(guildId, {
          statusChannelId: targetChannel.id,
          statusMessageId: null,
        });
        await refreshGuildMinecraftStatus(client, guildId);
        await interaction.editReply({
          content: `✅ Автоматическая Live статус-панель настроена в канале <#${targetChannel.id}>!`,
        });
        return;
      }

      if (subcommand === 'whitelist') {
        const enable = interaction.options.getBoolean('enable', true);
        await updateMinecraftConfig(guildId, { whitelistEnabled: enable });
        await interaction.editReply({
          content: enable
            ? '🛡️ **Обязательный вайтлист ВКЛЮЧЁН.** Теперь подключаться к серверу смогут только игроки с привязанным аккаунтом.'
            : '🔓 **Обязательный вайтлист ВЫКЛЮЧЁН.** Сервер открыт для свободного входа всех игроков.',
        });
        return;
      }

      if (subcommand === 'player-role') {
        const role = interaction.options.getRole('role', true);
        await updateMinecraftConfig(guildId, { playerRoleId: role.id });
        await interaction.editReply({
          content: `✅ Роль игрока при привязке аккаунта установлена на <@&${role.id}>.`,
        });
        return;
      }
    }
  },
};

export default mcCommand;
