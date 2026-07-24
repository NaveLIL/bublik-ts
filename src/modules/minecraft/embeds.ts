import { User } from 'discord.js';
import { BublikEmbed } from '../../core/EmbedBuilder';
import { MinecraftAccountData, MinecraftShopItemData } from './database';

export interface MinecraftServerMetrics {
  online: boolean;
  address: string;
  version?: string;
  modpack?: string;
  playersOnline: number;
  playersMax: number;
  playerList: string[];
  tps?: number;
  mspt?: number;
  pingMs?: number;
  cpuPercent?: number;
  ramUsedMb?: number;
  ramTotalMb?: number;
  voiceChatStatus?: boolean;
  frpStatus?: boolean;
  lastBackupAt?: Date | null;
  motd?: string;
}

export function buildMinecraftStatusEmbed(metrics: MinecraftServerMetrics): BublikEmbed {
  const embed = new BublikEmbed();

  if (!metrics.online) {
    embed
      .setColor(0xed4245)
      .setTitle(`🔴 EREZCRAFT | Сервер недоступен`)
      .setDescription(
        `### ⚠️ Сервер оффлайн или перезапускается\n\n` +
        `> **Адрес подключения:** \`${metrics.address}\`\n` +
        `> **Версия:** NeoForge 1.21.1\n` +
        `> **Сборка:** Create Ultimate Selection 2 (10.8.0)\n\n` +
        `*Если идёт плановый рестарт или прогрузка чанков, сервер вернётся в сеть в течение нескольких минут.*`
      )
      .setTimestamp();

    return embed;
  }

  const tps = metrics.tps ?? 20.0;
  const mspt = metrics.mspt ?? 0;
  const pingMs = metrics.pingMs;
  const isDegraded = tps < 15.0;

  const statusBadge = isDegraded ? '🟡 Высокая нагрузка' : '🟢 В сети (Отлично)';
  const color = isDegraded ? 0xfee75c : 0x57f287;

  // Ping quality indicator
  let pingText = '—';
  let pingEmoji = '⚪';
  if (pingMs !== undefined) {
    pingText = `${pingMs}ms`;
    pingEmoji = pingMs < 50 ? '🟢' : pingMs < 120 ? '🟡' : '🔴';
  }

  // TPS quality bar
  const tpsBar = tps >= 19.5 ? '█████' : tps >= 17 ? '████░' : tps >= 14 ? '███░░' : tps >= 10 ? '██░░░' : '█░░░░';

  const playerText =
    metrics.playerList.length > 0
      ? metrics.playerList.map((p) => `\`${p}\``).join(' • ')
      : '*На сервере сейчас никого нет*';

  embed
    .setColor(color)
    .setTitle(`⛏️ EREZCRAFT — Игровой Сервер`)
    .setDescription(
      `**Статус:** ${statusBadge}\n` +
      `**Адрес для входа:** \`${metrics.address}\``
    )
    .addFields(
      {
        name: '👥 Игроки онлайн',
        value: `**${metrics.playersOnline}** из **${metrics.playersMax}**\n${playerText}`,
        inline: false,
      },
      {
        name: '⚙️ Сборка & Версия',
        value: `• **Ядро:** NeoForge 1.21.1\n• **Модпак:** Create Ultimate (10.8.0)\n• **Voice:** Simple Voice Chat (2.6.21)`,
        inline: true,
      },
      {
        name: '⚡ Стабильность сервера',
        value: `• **TPS:** \`${tps.toFixed(1)}\` / 20.0 \`${tpsBar}\`\n• **MSPT:** \`${mspt.toFixed(1)}\` ms\n• **Задержка:** ${pingEmoji} \`${pingText}\``,
        inline: true,
      },
      {
        name: '🌐 Сеть & Сервисы',
        value: `🟢 **Game TCP:** \`25565\`\n🟢 **Voice UDP:** \`25454\`\n🟢 **Auth:** Vouch (Argon2id)`,
        inline: true,
      }
    )
    .setTimestamp();

  return embed;
}

export function buildMinecraftAlertEmbed(
  type: 'offline' | 'restored' | 'degraded',
  serverAddress: string,
  details?: string
): BublikEmbed {
  const embed = new BublikEmbed();

  if (type === 'offline') {
    embed
      .setColor(0xe74c3c)
      .setTitle('🚨 ВНИМАНИЕ: Сервер Minecraft недоступен!')
      .setDescription(
        `Сервер \`${serverAddress}\` перестали отвечать на запросы.\n` +
        (details ? `\n*Подробности:* ${details}` : '')
      );
  } else if (type === 'restored') {
    embed
      .setColor(0x2ecc71)
      .setTitle('✅ Сервер Minecraft снова в сети!')
      .setDescription(`Связь с сервером \`${serverAddress}\` успешно восстановлена.`);
  } else {
    embed
      .setColor(0xf1c40f)
      .setTitle('⚠️ ВНИМАНИЕ: Зафиксировано падение TPS!')
      .setDescription(
        `На сервере \`${serverAddress}\` зафиксирована повышенная нагрузка.\n` +
        (details ? `\n*Метрики:* ${details}` : '')
      );
  }

  embed.setTimestamp();
  return embed;
}

// ── Phase 2 Embeds ─────────────────────────────

export function buildMinecraftLinkEmbed(username: string, code: string): BublikEmbed {
  return new BublikEmbed()
    .info()
    .setTitle('🔑 Привязка аккаунта Minecraft')
    .setDescription(
      `### 🎮 Игровой ник: \`${username}\`\n\n` +
      `Ваш одноразовый код подтверждения:\n` +
      `# \` ${code} \`\n\n` +
      `> ⏳ **Срок действия кода:** 10 минут\n` +
      `> 💡 **Как подтвердить:** Введите команду \`/mc link username:${username} code:${code}\` в этом дискорд-сервере или используйте \`/link\` в игре.`
    )
    .setThumbnail(`https://mc-heads.net/avatar/${username}/128`)
    .setTimestamp();
}

export function buildMinecraftProfileEmbed(
  user: User,
  account: MinecraftAccountData | null
): BublikEmbed {
  const embed = new BublikEmbed();

  if (!account || !account.isLinked) {
    return embed
      .warning()
      .setTitle(`🎮 Профиль Minecraft | ${user.username}`)
      .setDescription(
        `❌ У этого пользователя **нет привязанного аккаунта Minecraft**.\n\n` +
        `💡 Используйте команду \`/mc link username:<ник>\` чтобы привязать свой игровой аккаунт.`
      );
  }

  const linkedDate = account.linkedAt
    ? `<t:${Math.floor(account.linkedAt.getTime() / 1000)}:R>`
    : 'Неизвестно';

  return embed
    .success()
    .setTitle(`🎮 Игровой Профиль | ${account.minecraftUsername}`)
    .setDescription(
      `**Участник Discord:** <@${account.discordId}>\n` +
      `**Игровой ник:** \`${account.minecraftUsername}\`\n` +
      `**Статус привязки:** ✅ Подтверждён\n` +
      `**Дата привязки:** ${linkedDate}`
    )
    .setThumbnail(`https://mc-heads.net/avatar/${account.minecraftUsername}/128`)
    .setTimestamp();
}

export function buildMinecraftRulesEmbed(): BublikEmbed {
  return new BublikEmbed()
    .info()
    .setTitle('📜 Правила сервера EREZCRAFT')
    .setDescription(
      `### ⚖️ Основные положения и устав сервера\n\n` +
      `1️⃣ **Честная игра:** Запрещено использование читов, X-Ray, дюпов и авто-кликеров.\n` +
      `2️⃣ **Приваты & Базы:** Сервер защищён через **FTB Chunks**. Гриферство и воровство на заприваченной территории чужой команды запрещено.\n` +
      `3️⃣ **Уважение:** Запрещены оскорбления, спам, токсичность и провокации в общем чате.\n` +
      `4️⃣ **Create & Постройки:** Стройте оптимизированные механизмы Create. В случае сильных лагов админы помогут временно остановить механизм.\n` +
      `5️⃣ **Торговля:** Разрешён бартер и обмен ресурсами за Шекели ₪.`
    )
    .setTimestamp();
}

export function buildMinecraftModpackEmbed(): BublikEmbed {
  return new BublikEmbed()
    .info()
    .setTitle('📦 Модпак EREZCRAFT | Create Ultimate Selection 2')
    .setDescription(
      `### 🛠️ Информация о технической сборке\n\n` +
      `• **Версия игры:** Minecraft 1.21.1\n` +
      `• **Загрузчик модов:** NeoForge (v21.1.234)\n` +
      `• **Основной мод:** *Create Selection 2 v10.8.0*\n` +
      `• **Доп. сервисы:** Simple Voice Chat, FTB Chunks, Vouch Auth\n\n` +
      `📥 **Адрес подключения:** \`play.erez.pro:25565\`\n` +
      `🎙️ **Голосовой чат:** \`play.erez.pro:25454/UDP\``
    )
    .setTimestamp();
}

export function buildMinecraftVoiceEmbed(): BublikEmbed {
  return new BublikEmbed()
    .info()
    .setTitle('🎙️ Голосовой чат (Simple Voice Chat)')
    .setDescription(
      `### 🎧 Настройка позиционного voice-чата\n\n` +
      `На сервере установлена модификация **Simple Voice Chat (2.6.21)**.\n\n` +
      `• **Серверний порт:** \`play.erez.pro:25454\` (протокол **UDP**)\n` +
      `• **Клавиша открытия настроек в игре:** \`V\` (по умолчанию)\n` +
      `• **Микрофон:** Выберите устройство ввода в меню по клавише \`V\`\n\n` +
      `💡 *Если голосовой чат горит серым или не подключается — убедитесь, что ваш провайдер не блокирует UDP порт 25454.*`
    )
    .setTimestamp();
}

// ── Phase 3 Embeds ─────────────────────────────

export function buildMinecraftShopEmbed(
  items: MinecraftShopItemData[],
  userWallet: number
): BublikEmbed {
  const embed = new BublikEmbed()
    .info()
    .setTitle('🛒 Магазин EREZCRAFT | Покупки за Шекели ₪')
    .setDescription(
      `💰 **Ваш баланс:** **\`${userWallet}\`** ₪\n` +
      `Покупайте ресурсы, компоненты Create и услуги прямо из Discord с мгновенной доставкой на сервер!\n` +
      `──────────────────────────────────────────`
    );

  for (const item of items) {
    embed.addFields({
      name: `${item.iconEmoji} ${item.name} — ${item.priceShekels} ₪`,
      value: `${item.description ?? 'Описание отсутствует'}\n` +
             `*Команда покупки:* \`/mc buy item_id:${item.id}\``,
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}

export function buildMinecraftPurchaseReceiptEmbed(
  item: MinecraftShopItemData,
  username: string,
  newWallet: number
): BublikEmbed {
  return new BublikEmbed()
    .success()
    .setTitle(`🎉 Покупка успешно выданa!`)
    .setDescription(
      `### ${item.iconEmoji} **${item.name}**\n\n` +
      `• **Получатель в игре:** \`${username}\`\n` +
      `• **Списано:** **\`${item.priceShekels}\`** ₪\n` +
      `• **Остаток на балансе:** **\`${newWallet}\`** ₪\n\n` +
      `📦 *Предмет отправлен в инвентарь игрока на сервере EREZCRAFT.*`
    )
    .setThumbnail(`https://mc-heads.net/avatar/${username}/128`)
    .setTimestamp();
}
