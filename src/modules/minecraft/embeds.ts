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
  const mspt = metrics.mspt ?? 14.5;
  const isDegraded = tps < 15.0;

  const statusBadge = isDegraded ? '🟡 Высокая нагрузка' : '🟢 В сети (Отлично)';
  const color = isDegraded ? 0xfee75c : 0x57f287;

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
        name: '⚡ Метрики работы',
        value: `• **TPS:** \`${tps.toFixed(1)}\` / 20.0\n• **MSPT:** \`${mspt.toFixed(1)}\` ms\n• **Защита:** FTB Chunks`,
        inline: true,
      },
      {
        name: '🌐 Туннели & Сервисы',
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
