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
  buildMinecraftShopEmbed,
  buildMinecraftShopComponents,
  buildMinecraftPurchaseReceiptEmbed,
  buildMinecraftPurchaseFailureText,
} from '../embeds';
import {
  updateMinecraftConfig,
  getMinecraftAccountByDiscordId,
  getMinecraftShopItems,
  createMinecraftShopItem,
  isSafeMinecraftShopPrice,
  MAX_MINECRAFT_SHOP_PRICE,
} from '../database';
import {
  requestAccountLink,
  processConfirmLink,
  processUnlinkAccount,
  getPlayerProfile,
  isValidMinecraftJavaUsername,
} from '../services/link-service';
import { purchaseMinecraftShopItem } from '../services/economy-bridge';
import { getDatabase } from '../../../core/Database';
import { Config } from '../../../config';
import { validateShopCommandTemplate } from '../services/shop-command-policy';
import { isMinecraftGuildEnabled } from '../constants';

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
        .setName('shop')
        .setDescription('Открыть магазин игровых предметов за Шекели ₪')
        .setDescriptionLocalizations({ ru: 'Открыть магазин игровых предметов за Шекели ₪' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Купить предмет в Minecraft за Шекели ₪')
        .setDescriptionLocalizations({ ru: 'Купить предмет в Minecraft за Шекели ₪' })
        .addStringOption((opt) =>
          opt
            .setName('item_id')
            .setDescription('ID товара из /mc shop')
            .setRequired(true)
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
        .addSubcommand((sub) =>
          sub
            .setName('chat-channel')
            .setDescription('Канал для кросс-чата Discord ↔ Minecraft (или отключить)')
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setDescription('Канал для трансляции чата (оставьте пустым, чтобы отключить)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('shop-add')
            .setDescription('Добавить новый предмет в /mc shop')
            .addStringOption((opt) =>
              opt
                .setName('name')
                .setDescription('Название предмета')
                .setRequired(true)
            )
            .addIntegerOption((opt) =>
              opt
                .setName('price')
                .setDescription('Цена в Шекелях ₪')
                .setMinValue(1)
                .setMaxValue(MAX_MINECRAFT_SHOP_PRICE)
                .setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName('command')
                .setDescription('RCON команда (например: give {username} minecraft:diamond 5)')
                .setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName('icon')
                .setDescription('Эмодзи иконка (например: 💎)')
                .setRequired(false)
            )
            .addStringOption((opt) =>
              opt
                .setName('description')
                .setDescription('Описание предмета')
                .setRequired(false)
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

    if (!isMinecraftGuildEnabled(guildId)) {
      await interaction.reply({
        content: '⛔ Minecraft-модуль не подключён к этому Discord-серверу.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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

    // Handle /mc shop
    if (subcommand === 'shop') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const db = getDatabase();
      const profile = await db.economyProfile.findUnique({
        where: { guildId_userId: { guildId, userId: interaction.user.id } },
      });
      const userWallet = profile?.wallet ?? 0;
      const items = await getMinecraftShopItems(guildId);
      const embed = buildMinecraftShopEmbed(items, userWallet, 'resources');
      const components = buildMinecraftShopComponents(items, 'resources');
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Handle /mc buy
    if (subcommand === 'buy') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const itemId = interaction.options.getString('item_id', true).trim();
      const result = await purchaseMinecraftShopItem(guildId, member, itemId);

      if (!result.success) {
        await interaction.editReply({ content: buildMinecraftPurchaseFailureText(result) });
        return;
      }

      const account = await getMinecraftAccountByDiscordId(guildId, interaction.user.id);
      const embed = buildMinecraftPurchaseReceiptEmbed(result.item!, account!.minecraftUsername, result.newBalance!);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Handle /mc link
    if (subcommand === 'link') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const username = interaction.options.getString('username', true).trim();
      const code = interaction.options.getString('code')?.trim();

      if (!isValidMinecraftJavaUsername(username)) {
        await interaction.editReply({
          content: '❌ Некорректный Minecraft Java ник. Используйте от 3 до 16 латинских букв, цифр или символов подчёркивания.',
        });
        return;
      }

      const existing = await getMinecraftAccountByDiscordId(guildId, interaction.user.id);
      if (existing?.isLinked) {
        await interaction.editReply({
          content: `⚠️ Ваш аккаунт Discord уже привязан к игроку **\`${existing.minecraftUsername}\`**.\nЕсли вы хотите сменить ник, сначала используйте \`/mc unlink\`.`,
        });
        return;
      }

      if (code) {
        const confirmResult = await processConfirmLink(guildId, member, code, username);

        if (!confirmResult.success) {
          let reasonText = 'Неверный код подтверждения.';
          if (confirmResult.reason === 'CODE_EXPIRED') {
            reasonText = '⏱️ Срок действия кода истёк. Сгенерируйте новый код повторным вызовом `/mc link username:<ник>`.';
          } else if (confirmResult.reason === 'NOT_FOUND') {
            reasonText = '❌ Сначала запросите код командой `/mc link username:<ник>`.';
          } else if (confirmResult.reason === 'USERNAME_MISMATCH') {
            reasonText = '❌ Ник не совпадает с заявкой на привязку. Запросите новый код для нужного ника.';
          } else if (confirmResult.reason === 'RCON_UNAVAILABLE') {
            reasonText = '⚠️ Игровое подтверждение сейчас недоступно. Аккаунт не был привязан; попробуйте позже.';
          } else if (confirmResult.reason === 'VERIFICATION_FAILED') {
            reasonText = '❌ Сервер Minecraft не подтвердил этот код. Выполните подтверждение в игре и повторите попытку.';
          }
          await interaction.editReply({ content: reasonText });
          return;
        }

        await interaction.editReply({
          content: `🎉 **Успешно!** Игровой аккаунт **\`${confirmResult.account?.minecraftUsername}\`** официально привязан к вашей учетной записи Discord!`,
        });
        return;
      }

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
      const isOwnerOnlyShopAdd = subcommand === 'shop-add';
      const isConfiguredOwner = Boolean(Config.ownerId) && interaction.user.id === Config.ownerId;
      const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

      if (isOwnerOnlyShopAdd ? !isConfiguredOwner : !canManageGuild) {
        await interaction.reply({
          content: isOwnerOnlyShopAdd
            ? '⛔ Добавлять RCON-товары может только настроенный владелец бота.'
            : '⛔ Только администраторы сервера могут изменять настройки модуля Minecraft.',
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

      if (subcommand === 'chat-channel') {
        const targetChannel = interaction.options.getChannel('channel');
        await updateMinecraftConfig(guildId, { chatChannelId: targetChannel?.id ?? null });
        await interaction.editReply({
          content: targetChannel
            ? `✅ Кросс-чат (Discord ↔ Minecraft) настроен в канале <#${targetChannel.id}>!\n💡 Сообщения в этом канале будут доставляться игрокам в игру и наоборот.`
            : `🔇 Кросс-чат отключён.`,
        });
        return;
      }

      if (subcommand === 'shop-add') {
        const name = interaction.options.getString('name', true).trim();
        const price = interaction.options.getInteger('price', true);
        const commandStr = interaction.options.getString('command', true).trim();
        const icon = interaction.options.getString('icon')?.trim() ?? '📦';
        const desc = interaction.options.getString('description')?.trim();

        if (!isSafeMinecraftShopPrice(price)) {
          await interaction.editReply({
            content: `❌ Цена должна быть целым числом от 1 до ${MAX_MINECRAFT_SHOP_PRICE.toLocaleString('ru-RU')} ₪.`,
          });
          return;
        }

        const commandPolicy = validateShopCommandTemplate(commandStr);
        if (!commandPolicy.ok) {
          await interaction.editReply({
            content: `❌ Небезопасный шаблон выдачи. ${commandPolicy.reason}`,
          });
          return;
        }

        const newItem = await createMinecraftShopItem(guildId, {
          name,
          priceShekels: price,
          rconCommand: commandPolicy.commands.join('; '),
          iconEmoji: icon,
          description: desc,
        });

        await interaction.editReply({
          content: `✅ В магазин добавлен новый предмет: ${newItem.iconEmoji} **${newItem.name}** за **${newItem.priceShekels}** ₪ (ID: \`${newItem.id}\`)`,
        });
        return;
      }
    }
  },
};

export default mcCommand;
