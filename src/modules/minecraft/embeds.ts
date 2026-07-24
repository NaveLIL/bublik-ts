import { BublikEmbed } from '../../core/EmbedBuilder';

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
      .setColor(0xe74c3c)
      .setTitle(`🎮 Статус сервера: ${metrics.address}`)
      .setDescription(
        `🔴 **СЕРВЕР ОФФЛАЙН ИЛИ ПЕРЕЗАПУСКАЕТСЯ**\n\n` +
        `• **Адрес подключения:** \`${metrics.address}\`\n` +
        `• **Версия:** NeoForge 1.21.1\n` +
        `• **Модпак:** Create Ultimate Selection 2 10.8.0\n` +
        `• **Голосовой чат:** Simple Voice Chat (\`play.erez.pro:25454/UDP\`)\n\n` +
        `⚠️ *Если идёт плановый рестарт или генерация мира Chunky, сервер вернётся в сеть в течение нескольких минут.*`
      )
      .setFooter({ text: `Обновлено: ${new Date().toLocaleTimeString('ru-RU')} | EREZCRAFT Status` });

    return embed;
  }

  const tps = metrics.tps ?? 20.0;
  const mspt = metrics.mspt ?? 14.5;
  const isDegraded = tps < 15.0;

  const statusEmoji = isDegraded ? '🟡' : '🟢';
  const statusText = isDegraded ? 'Высокая нагрузка' : 'В сети (Стабильно)';
  const color = isDegraded ? 0xf1c40f : 0x2ecc71;

  const playerText =
    metrics.playerList.length > 0
      ? metrics.playerList.map((p) => `\`${p}\``).join(', ')
      : '*Никого в сети*';

  embed
    .setColor(color)
    .setTitle(`${statusEmoji} EREZCRAFT — ${statusText}`)
    .setDescription(
      `🌐 **Адрес:** \`${metrics.address}\`\n` +
      `📦 **Версия / Сборка:** NeoForge 1.21.1 | *Create Ultimate Selection 2 10.8.0*\n` +
      `🎙️ **Voice Chat:** Simple Voice Chat 2.6.21 (\`play.erez.pro:25454/UDP\`)`
    )
    .addFields(
      {
        name: `👥 Игроки онлайн (${metrics.playersOnline}/${metrics.playersMax})`,
        value: playerText,
        inline: false,
      },
      {
        name: '⚡ TPS / MSPT',
        value: `**${tps.toFixed(1)}** TPS | **${mspt.toFixed(1)}** mspt`,
        inline: true,
      },
      {
        name: '🛡️ Защита & Авторизация',
        value: `Vouch (Argon2id) | FTB Chunks`,
        inline: true,
      },
      {
        name: '🔗 Сетевые туннели',
        value: `🟢 FRP TCP (25565)\n🟢 Voice UDP (25454)`,
        inline: true,
      }
    )
    .setFooter({ text: `Обновлено: ${new Date().toLocaleTimeString('ru-RU')} | EREZCRAFT Monitoring` });

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
