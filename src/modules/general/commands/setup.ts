import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
  ComponentType,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { BublikCommand, CommandScope } from '../../../types';
import { getDatabase } from '../../../core/Database';
import { getGuildConfig, getGuildLocale } from '../../../core/GuildConfig';
import { BublikEmbed } from '../../../core/EmbedBuilder';
import { Config } from '../../../config';
import type { BublikClient } from '../../../bot';
import { logger } from '../../../core/Logger';
import { i18n } from '../../../core/I18n';

// ── Типы и хелперы проверки статуса ────────────

async function getSetupStatus(guildId: string) {
  const db = getDatabase();

  // 1. Welcome
  const welcomeCfg = await getGuildConfig(guildId);
  const welcomeOk = !!(welcomeCfg.welcomeChannelId || welcomeCfg.autoRoleId || welcomeCfg.memberRoleId);

  // 2. Economy
  const ecoConfig = await db.economyConfig.findUnique({ where: { guildId } });
  const ecoOk = !!ecoConfig;

  // 3. RegBattle
  const regConfig = await db.regbattleConfig.findUnique({ where: { guildId } });
  const regOk = !!regConfig;

  // 4. TempVoice
  const tempVoiceCount = await db.tempvoiceGenerator.count({ where: { guildId } });
  const tempVoiceOk = tempVoiceCount > 0;

  // 5. Vacation
  const vacConfig = await db.vacationConfig.findUnique({ where: { guildId } });
  const vacOk = !!vacConfig;

  // 6. Teams
  const teamConfig = await db.teamConfig.findUnique({ where: { guildId } });
  const teamOk = !!teamConfig;

  // 7. WT BR
  const brPanel = await db.brPanel.findUnique({ where: { guildId } });
  const brTechCount = await db.brTechEntry.count({ where: { guildId } });
  const brOk = !!brPanel || brTechCount > 0;

  return {
    welcomeOk,
    ecoOk,
    regOk,
    tempVoiceOk,
    vacOk,
    teamOk,
    brOk,
    brTechCount,
  };
}

function buildDashboardEmbed(status: any, guildName: string, guildId: string, locale: string): BublikEmbed {
  const isRu = locale === 'ru';
  const embed = new BublikEmbed()
    .setTitle(isRu ? `⚙️ Панель настройки: ${guildName}` : `⚙️ Setup Dashboard: ${guildName}`)
    .setDescription(
      isRu
        ? 'Здесь вы можете проверить статус настройки каждого модуля бота для вашего сервера.'
        : 'Here you can check the setup status of each bot module for your server.'
    );

  const statusStr = (ok: boolean) => (ok ? '🟢 ' + (isRu ? 'Настроено' : 'Configured') : '🔴 ' + (isRu ? 'Не настроено' : 'Not Configured'));

  embed.addFields(
    { name: '👤 ' + (isRu ? 'Приветствия и авто-роли' : 'Welcome & Auto-roles'), value: statusStr(status.welcomeOk), inline: true },
    { name: '💰 ' + (isRu ? 'Экономика' : 'Economy'), value: statusStr(status.ecoOk), inline: true },
    { name: '🎙️ ' + (isRu ? 'Временные голосовые каналы' : 'Temporary Voice Channels'), value: statusStr(status.tempVoiceOk), inline: true },
    { name: '⚔️ ' + (isRu ? 'Полковые бои (ПБ)' : 'Regimental Battles (PB)'), value: statusStr(status.regOk), inline: true },
    { name: '🏖️ ' + (isRu ? 'Система отпусков' : 'Vacations System'), value: statusStr(status.vacOk), inline: true },
    { name: '👥 ' + (isRu ? 'Система команд' : 'Teams System'), value: statusStr(status.teamOk), inline: true },
    {
      name: '📊 ' + (isRu ? 'Справочник БР' : 'BR Reference'),
      value: statusStr(status.brOk) + (status.brTechCount > 0 ? ` (${status.brTechCount} ${isRu ? 'техн.' : 'tech'})` : ''),
      inline: true,
    }
  );

  const isNs = guildId === Config.nsGuildId;
  embed.addFields({
    name: '🛡️ ' + (isRu ? 'Небесные Стражи' : 'Celestial Guardians'),
    value: isNs
      ? '🟢 ' + (isRu ? 'Включено для этого сервера' : 'Enabled for this server')
      : '⚪ ' + (isRu ? 'Не используется на этом сервере' : 'Disabled on this server'),
    inline: true,
  });

  embed.setFooter({
    text: isRu
      ? 'Выберите модуль в меню ниже для просмотра пошаговой инструкции.'
      : 'Select a module in the menu below to view step-by-step instructions.',
  });

  return embed.info();
}

function buildSelectMenu(selected: string, locale: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const isRu = locale === 'ru';
  const menu = new StringSelectMenuBuilder()
    .setCustomId('setup:module')
    .setPlaceholder(isRu ? 'Выберите модуль для настройки' : 'Select a module to configure')
    .addOptions(
      {
        label: isRu ? 'Главный дашборд' : 'Main Dashboard',
        value: 'dashboard',
        emoji: '⚙️',
        default: selected === 'dashboard',
      },
      {
        label: isRu ? 'Приветствия и авто-роли' : 'Welcome & Auto-roles',
        value: 'welcome',
        emoji: '👤',
        default: selected === 'welcome',
      },
      {
        label: isRu ? 'Экономика и PB-тиры' : 'Economy & PB Tiers',
        value: 'economy',
        emoji: '💰',
        default: selected === 'economy',
      },
      {
        label: isRu ? 'Временные войсы' : 'Temporary Voice Channels',
        value: 'tempvoice',
        emoji: '🎙️',
        default: selected === 'tempvoice',
      },
      {
        label: isRu ? 'Полковые Бои (ПБ)' : 'Regimental Battles (PB)',
        value: 'regbattle',
        emoji: '⚔️',
        default: selected === 'regbattle',
      },
      {
        label: isRu ? 'Система отпусков' : 'Vacations System',
        value: 'vacation',
        emoji: '🏖️',
        default: selected === 'vacation',
      },
      {
        label: isRu ? 'Система команд' : 'Teams System',
        value: 'teams',
        emoji: '👥',
        default: selected === 'teams',
      },
      {
        label: isRu ? 'Справочник БР' : 'BR Reference',
        value: 'br',
        emoji: '📊',
        default: selected === 'br',
      }
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildModuleInstructionsEmbed(moduleName: string, locale: string): BublikEmbed {
  const isRu = locale === 'ru';
  const embed = new BublikEmbed();

  switch (moduleName) {
    case 'welcome':
      embed.setTitle(isRu ? '👤 Настройка приветствий и авто-ролей' : '👤 Welcome & Auto-roles Configuration')
        .setDescription(
          isRu
            ? 'Модуль выдаёт роли новым участникам при входе и отправляет приветственные сообщения.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Выберите или создайте текстовый канал для приветствий.\n' +
              '2. Выберите роль, которая выдаётся мгновенно при входе (например, `@Новобранец`).\n' +
              '3. (Опционально) Задайте роль полноценного участника (авто-роль снимется при её выдаче).\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/welcome setup auto_role:@Роль welcome_channel:#Канал` — базовая настройка.\n' +
              '• `/welcome setup member_role:@Роль recruit_role:@Роль ticket_channel:#Канал` — настройка ролей участника/кандидата и канала тикетов.\n' +
              '• `/welcome config` — показать текущие настройки модуля.\n' +
              '• `/welcome reset setting:autoRoleId` — сбросить конкретную настройку.'
            : 'Configures welcome messages and automatic roles for new members.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Set up a welcome text channel.\n' +
              '2. Select a role given immediately upon join (e.g. `@Recruit`).\n' +
              '3. Select a member role (auto-role is removed when this is given).\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/welcome setup auto_role:@Role welcome_channel:#Channel` — basic setup.\n' +
              '• `/welcome setup member_role:@Role recruit_role:@Role ticket_channel:#Channel` — advanced setup.\n' +
              '• `/welcome config` — show current configuration.\n' +
              '• `/welcome reset setting:autoRoleId` — reset specific setting.'
        );
      break;

    case 'economy':
      embed.setTitle(isRu ? '💰 Настройка экономики и PB-тиров' : '💰 Economy & PB Tiers Configuration')
        .setDescription(
          isRu
            ? 'Модуль добавляет систему шекелей, банки, казино, маркетплейс ролей, а также начисление шекелей за голосовую активность.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Настройте каналы для новостей экономики, логов транзакций, авто-лидерборда и модерации магазина.\n' +
              '2. Задайте роли для PB-тиров (всего доступно 10 уровней в зависимости от часов в войсе).\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/economy setup news:#Канал log:#Канал leaderboard:#Канал market:#Канал welcomebonus:500` — настройка каналов и стартового бонуса.\n' +
              '• `/economy roles tier1:@Роль tier2:@Роль ...` — задать роли для 10 голосовых тиров.\n' +
              '• `/economy toggle` — включить или полностью выключить экономику на сервере.\n' +
              '• `/economy config` — посмотреть текущую конфигурацию экономики.\n' +
              '• `/shop add` — добавить товары в магазин ролей.\n' +
              '• `/shop list` — посмотреть список товаров.'
            : 'Enables wallet/bank, daily/weekly claims, slots/blackjack, role shop, and voice channel rewards.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Set up economy logs, news, leaderboard, and marketplace moderation channels.\n' +
              '2. Configure roles for PB voice activity tiers (10 tiers total).\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/economy setup news:#Channel log:#Channel leaderboard:#Channel market:#Channel welcomebonus:500` — configure channels.\n' +
              '• `/economy roles tier1:@Role tier2:@Role ...` — assign roles to 10 voice tiers.\n' +
              '• `/economy toggle` — enable/disable economy.\n' +
              '• `/economy config` — show configuration.\n' +
              '• `/shop add` — add roles to the shop.'
        );
      break;

    case 'tempvoice':
      embed.setTitle(isRu ? '🎙️ Настройка временных голосовых каналов' : '🎙️ Temporary Voice Channels Configuration')
        .setDescription(
          isRu
            ? 'Автоматическое создание персональных голосовых каналов для участников с панелью управления.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Создайте голосовой канал-генератор (например, `➕ Создать канал`).\n' +
              '2. Создайте категорию, в которой будут появляться временные каналы.\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/voice setup channel:ГолосовойКанал category:Категория` — сделать выбранный канал генератором.\n' +
              '• `/voice list` — список всех активных генераторов.\n' +
              '• `/voice remove channel:ГолосовойКанал` — отключить генератор.\n' +
              '• `/voice addrole channel:ГолосовойКанал role:@Роль` — добавить роль модератора для генератора.'
            : 'Allows members to create their own temporary voice rooms by joining a generator channel.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Create a generator voice channel (e.g. `➕ Create Room`).\n' +
              '2. Create a Discord category where temporary rooms will appear.\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/voice setup channel:VoiceChannel category:Category` — define a generator.\n' +
              '• `/voice list` — list active generators.\n' +
              '• `/voice remove channel:VoiceChannel` — delete generator.'
        );
      break;

    case 'regbattle':
      embed.setTitle(isRu ? '⚔️ Настройка Полковых Боев (ПБ)' : '⚔️ Regimental Battles (PB) Configuration')
        .setDescription(
          isRu
            ? 'Автоматизация сбора отрядов для полковых боёв. Создаёт временные отряды (1-й отряд, 2-й отряд) в войсе при входе в мастер-канал.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Настройте войс-генератор (мастер) и категорию для отрядов.\n' +
              '2. Настройте канал для пингов ПБ и войс-канал для запасных.\n' +
              '3. Укажите роль «В отряде» и роли командиров.\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/regbattle setup master:Войс category:Категория announce:Канал` — настройка каналов и категорий.\n' +
              '• `/regbattle setup reserve:Войс ping_role:@Роль insquad_role:@Роль` — настройка ролей и запаса.\n' +
              '• `/regbattle addrole type:commander role:@Роль` — добавить роль полевого командира.\n' +
              '• `/regbattle config` — показать настройки ПБ.\n' +
              '• `/regbattle close` — принудительно расформировать все ПБ-отряды.'
            : 'Automates squad creation and reserve management for clan war sessions.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Designate a master join channel and a category for temporary rooms.\n' +
              '2. Choose an announcement channel and a reserve channel.\n' +
              '3. Configure roles (e.g., `In Squad` role and commander roles).\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/regbattle setup master:Voice category:Category announce:Channel` — setup core elements.\n' +
              '• `/regbattle setup reserve:Voice ping_role:@Role insquad_role:@Role` — setup helper options.\n' +
              '• `/regbattle addrole type:commander role:@Role` — define a commander role.'
        );
      break;

    case 'vacation':
      embed.setTitle(isRu ? '🏖️ Настройка системы отпусков' : '🏖️ Vacations System Configuration')
        .setDescription(
          isRu
            ? 'Позволяет участникам брать отпуска, временно освобождая их от обязанностей и ролей на время отсутствия.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Создайте канал для заявок на отпуск (review) и канал для логов (log).\n' +
              '2. Укажите роль отпуска и роли, которые должны автоматически сниматься.\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/vacation setup review:#Канал log:#Канал role:@Роль отпуска` — первичная настройка.\n' +
              '• `/vacation addrole type:remove role:@Роль` — добавить роль, которая снимается в отпуске (например, прайм-роли).\n' +
              '• `/vacation addrole type:reviewer role:@Роль` — добавить роль куратора отпусков (кто одобряет).\n' +
              '• `/vacation panel channel:#Канал` — отправить интерактивную панель для ухода в отпуск.\n' +
              '• `/vacation primetime start:17 end:1` — настроить часы прайм-тайма (когда уход блокируется).\n' +
              '• `/vacation antiabuse cooldown:3 max_per_month:5` — настроить защиту от спама.'
            : 'Allows members to take leave, temporarily removing select roles during their absence.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Create a channel for reviews and another for logs.\n' +
              '2. Choose a vacation role and identify roles that should be removed.\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/vacation setup review:#Channel log:#Channel role:@LeaveRole` — setup channels and role.\n' +
              '• `/vacation addrole type:remove role:@Role` — add a role to be removed on leave.\n' +
              '• `/vacation addrole type:reviewer role:@Role` — define who can approve leave.\n' +
              '• `/vacation panel channel:#Channel` — send the interactive UI panel.'
        );
      break;

    case 'teams':
      embed.setTitle(isRu ? '👥 Настройка системы полковых команд' : '👥 Teams System Configuration')
        .setDescription(
          isRu
            ? 'Игроки могут создавать свои постоянные команды (мини-составы) со своими ролями, проводить тренировки и праймы и заполнять отчеты.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Создайте каналы для заявок на команды, отчётов, сборов (опросов) и лидерборда.\n' +
              '2. Задайте базовую роль (кто имеет доступ к командам) и одобряющие роли.\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/team setup application_channel:#Канал report_channel:#Канал poll_channel:#Канал` — настройка каналов.\n' +
              '• `/team setup leaderboard_channel:#Канал base_role:@Роль` — настройка лидерборда и ролей доступа.\n' +
              '• `/team config` — показать конфигурацию командной системы.\n' +
              '• `/team create` — начать создание новой команды.'
            : 'Lets players build permanent squads, run sessions, submit reports, and track team leaderboard.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Setup channels for applications, reports, polls, and leaderboard.\n' +
              '2. Setup access roles and reviewer roles.\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/team setup application_channel:#Channel report_channel:#Channel poll_channel:#Channel` — configure channels.\n' +
              '• `/team config` — show setup details.'
        );
      break;

    case 'br':
      embed.setTitle(isRu ? '📊 Настройка справочника БР' : '📊 BR Reference Configuration')
        .setDescription(
          isRu
            ? 'Справочник техники по боевым рейтингам (БР) для War Thunder и автоматическое расписание ротаций.\n\n' +
              '💡 **Рекомендуемый порядок настройки:**\n' +
              '1. Настройте расписание ротаций БР с помощью команды `/br rotation-update` с прикреплением JSON-файла.\n' +
              '2. Отправьте интерактивную панель-справочник в текстовый канал.\n\n' +
              '🛠️ **Доступные команды:**\n' +
              '• `/br panel channel:#Канал` — развернуть панель-справочник БР в текстовом канале.\n' +
              '• `/br rotation-update` — обновить файл ротаций (прикрепите JSON-файл).\n' +
              '• `/br rating value:10.3` — посмотреть технику для конкретного боевого рейтинга.\n\n' +
              '✏️ **Импорт техники:**\n' +
              'Поскольку база данных техники содержит сотни записей, её импорт производится один раз из файла через консоль с помощью скрипта:\n' +
              '`ts-node scripts/migrate-br.ts <guildId> < br_entries.tsv`.'
            : 'War Thunder battle rating database and automatic rotation schedules.\n\n' +
              '💡 **Recommended Order:**\n' +
              '1. Update the BR rotation schedule using `/br rotation-update` with a JSON attachment.\n' +
              '2. Deploy the reference panel.\n\n' +
              '🛠️ **Available Commands:**\n' +
              '• `/br panel channel:#Channel` — deploy interactive panel.\n' +
              '• `/br rotation-update` — load rotation schedule.'
        );
      break;
  }

  return embed.info();
}

// ── Определение команды ────────────────────────

const setupCommand: BublikCommand = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Мастер настройки систем бота (только для Администраторов)')
    .setDescriptionLocalizations({
      'en-US': 'Setup wizard for bot modules (Administrators only)',
      'en-GB': 'Setup wizard for bot modules (Administrators only)',
    })
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  scope: CommandScope.Guild,
  category: 'admin',
  descriptionKey: 'commands.setup.description',
  cooldown: 5,

  async execute(interaction: ChatInputCommandInteraction, _client: BublikClient): Promise<void> {
    const guildId = interaction.guildId!;
    const guildName = interaction.guild?.name || 'Discord Server';
    const locale = await getGuildLocale(guildId);

    // Discord's default command permissions control normal visibility, but the
    // handler remains authoritative if guild command overrides are changed.
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: i18n.t('errors.no_permission', locale),
        ephemeral: true,
      });
      return;
    }

    // Первоначальное чтение статуса
    let status = await getSetupStatus(guildId);

    const reply = await interaction.reply({
      embeds: [buildDashboardEmbed(status, guildName, guildId, locale)],
      components: [buildSelectMenu('dashboard', locale)],
      ephemeral: true,
      fetchReply: true,
    });

    try {
      const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 10 * 60_000, // 10 минут активности
        filter: (i) => i.user.id === interaction.user.id && i.customId === 'setup:module',
      });

      collector.on('collect', async (i: StringSelectMenuInteraction) => {
        const selected = i.values[0] || 'dashboard';

        if (selected === 'dashboard') {
          // Обновляем статус при возврате на главный экран
          status = await getSetupStatus(guildId);
          await i.update({
            embeds: [buildDashboardEmbed(status, guildName, guildId, locale)],
            components: [buildSelectMenu('dashboard', locale)],
          }).catch(() => {});
        } else {
          await i.update({
            embeds: [buildModuleInstructionsEmbed(selected, locale)],
            components: [buildSelectMenu(selected, locale)],
          }).catch(() => {});
        }
      });

      collector.on('end', async () => {
        await interaction.editReply({ components: [] }).catch(() => {});
      });
    } catch (err) {
      log.error('Ошибка создания коллектора для команды setup', err);
    }
  },
};

const log = logger.child('Setup:Command');

export default setupCommand;
