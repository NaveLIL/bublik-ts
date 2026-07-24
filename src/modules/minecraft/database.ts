import { getDatabase } from '../../core/Database';
import { DEFAULT_SERVER_ADDRESS, DEFAULT_SERVER_NAME } from './constants';

export interface MinecraftConfigData {
  id: string;
  guildId: string;
  statusChannelId: string | null;
  statusMessageId: string | null;
  chatChannelId: string | null;
  serverAddress: string;
  serverName: string;
  lastStatus: string | null;
  lastAlertSentAt: Date | null;
  whitelistEnabled: boolean;
  playerRoleId: string | null;
}

export interface MinecraftAccountData {
  id: string;
  guildId: string;
  discordId: string;
  minecraftUsername: string;
  minecraftUuid: string | null;
  linkCode: string | null;
  linkCodeExpiresAt: Date | null;
  isLinked: boolean;
  linkedAt: Date | null;
  playtimeMinutes: number;
  lastRewardAt: Date | null;
  totalEarnedShekels: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MinecraftShopItemData {
  id: string;
  guildId: string;
  name: string;
  description: string | null;
  priceShekels: number;
  rconCommand: string;
  iconEmoji: string;
  category: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function getMinecraftConfig(guildId: string): Promise<MinecraftConfigData | null> {
  const db = getDatabase();
  return db.minecraftConfig.findUnique({
    where: { guildId },
  }) as Promise<MinecraftConfigData | null>;
}

export async function getOrCreateMinecraftConfig(guildId: string): Promise<MinecraftConfigData> {
  const db = getDatabase();
  return db.minecraftConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      serverAddress: DEFAULT_SERVER_ADDRESS,
      serverName: DEFAULT_SERVER_NAME,
      whitelistEnabled: false,
    },
    update: {},
  }) as Promise<MinecraftConfigData>;
}

export async function updateMinecraftConfig(
  guildId: string,
  data: {
    statusChannelId?: string | null;
    statusMessageId?: string | null;
    chatChannelId?: string | null;
    serverAddress?: string;
    serverName?: string;
    lastStatus?: string | null;
    lastAlertSentAt?: Date | null;
    whitelistEnabled?: boolean;
    playerRoleId?: string | null;
  }
): Promise<MinecraftConfigData> {
  const db = getDatabase();
  return db.minecraftConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      statusChannelId: data.statusChannelId ?? null,
      statusMessageId: data.statusMessageId ?? null,
      chatChannelId: data.chatChannelId ?? null,
      serverAddress: data.serverAddress ?? DEFAULT_SERVER_ADDRESS,
      serverName: data.serverName ?? DEFAULT_SERVER_NAME,
      lastStatus: data.lastStatus ?? null,
      lastAlertSentAt: data.lastAlertSentAt ?? null,
      whitelistEnabled: data.whitelistEnabled ?? false,
      playerRoleId: data.playerRoleId ?? null,
    },
    update: data,
  }) as Promise<MinecraftConfigData>;
}

export async function getAllMinecraftConfigs(): Promise<MinecraftConfigData[]> {
  const db = getDatabase();
  return db.minecraftConfig.findMany() as Promise<MinecraftConfigData[]>;
}

// ── Minecraft Accounts ──────────────────────────

export async function getMinecraftAccountByDiscordId(
  guildId: string,
  discordId: string
): Promise<MinecraftAccountData | null> {
  const db = getDatabase();
  return db.minecraftAccount.findUnique({
    where: { guildId_discordId: { guildId, discordId } },
  }) as Promise<MinecraftAccountData | null>;
}

export async function getMinecraftAccountByUsername(
  guildId: string,
  minecraftUsername: string
): Promise<MinecraftAccountData | null> {
  const db = getDatabase();
  return db.minecraftAccount.findUnique({
    where: { guildId_minecraftUsername: { guildId, minecraftUsername } },
  }) as Promise<MinecraftAccountData | null>;
}

export async function createLinkCode(
  guildId: string,
  discordId: string,
  minecraftUsername: string,
  linkCode: string,
  expiresAt: Date
): Promise<MinecraftAccountData> {
  const db = getDatabase();
  return db.minecraftAccount.upsert({
    where: { guildId_discordId: { guildId, discordId } },
    create: {
      guildId,
      discordId,
      minecraftUsername,
      linkCode,
      linkCodeExpiresAt: expiresAt,
      isLinked: false,
    },
    update: {
      minecraftUsername,
      linkCode,
      linkCodeExpiresAt: expiresAt,
      isLinked: false,
    },
  }) as Promise<MinecraftAccountData>;
}

export async function confirmAccountLink(
  guildId: string,
  discordId: string,
  code: string
): Promise<{ success: boolean; account?: MinecraftAccountData; reason?: string }> {
  const db = getDatabase();
  const account = await db.minecraftAccount.findUnique({
    where: { guildId_discordId: { guildId, discordId } },
  });

  if (!account) {
    return { success: false, reason: 'NOT_FOUND' };
  }

  if (account.isLinked) {
    return { success: false, reason: 'ALREADY_LINKED' };
  }

  if (account.linkCode !== code) {
    return { success: false, reason: 'INVALID_CODE' };
  }

  if (account.linkCodeExpiresAt && account.linkCodeExpiresAt < new Date()) {
    return { success: false, reason: 'CODE_EXPIRED' };
  }

  const updated = await db.minecraftAccount.update({
    where: { guildId_discordId: { guildId, discordId } },
    data: {
      isLinked: true,
      linkedAt: new Date(),
      linkCode: null,
      linkCodeExpiresAt: null,
    },
  });

  return { success: true, account: updated as MinecraftAccountData };
}

export async function forceLinkMinecraftAccount(
  guildId: string,
  discordId: string,
  minecraftUsername: string
): Promise<MinecraftAccountData> {
  const db = getDatabase();
  return db.minecraftAccount.upsert({
    where: { guildId_discordId: { guildId, discordId } },
    create: {
      guildId,
      discordId,
      minecraftUsername,
      isLinked: true,
      linkedAt: new Date(),
    },
    update: {
      minecraftUsername,
      isLinked: true,
      linkedAt: new Date(),
      linkCode: null,
      linkCodeExpiresAt: null,
    },
  }) as Promise<MinecraftAccountData>;
}

export async function unlinkMinecraftAccount(
  guildId: string,
  discordId: string
): Promise<boolean> {

  const db = getDatabase();
  try {
    await db.minecraftAccount.delete({
      where: { guildId_discordId: { guildId, discordId } },
    });
    return true;
  } catch {
    return false;
  }
}

// ── Minecraft Shop Items ────────────────────────

export async function getMinecraftShopItems(guildId: string): Promise<MinecraftShopItemData[]> {
  const db = getDatabase();
  const items = await db.minecraftShopItem.findMany({
    where: { guildId, isActive: true },
    orderBy: { priceShekels: 'asc' },
  });

  if (items.length === 0) {
    return seedDefaultMinecraftShopItems(guildId);
  }

  return items as MinecraftShopItemData[];
}

export async function getMinecraftShopItemById(id: string): Promise<MinecraftShopItemData | null> {
  const db = getDatabase();
  return db.minecraftShopItem.findUnique({
    where: { id },
  }) as Promise<MinecraftShopItemData | null>;
}

export async function createMinecraftShopItem(
  guildId: string,
  data: {
    name: string;
    description?: string;
    priceShekels: number;
    rconCommand: string;
    iconEmoji?: string;
    category?: string;
  }
): Promise<MinecraftShopItemData> {
  const db = getDatabase();
  return db.minecraftShopItem.create({
    data: {
      guildId,
      name: data.name,
      description: data.description ?? null,
      priceShekels: data.priceShekels,
      rconCommand: data.rconCommand,
      iconEmoji: data.iconEmoji ?? '📦',
      category: data.category ?? 'general',
      isActive: true,
    },
  }) as Promise<MinecraftShopItemData>;
}

export async function seedDefaultMinecraftShopItems(guildId: string): Promise<MinecraftShopItemData[]> {
  const db = getDatabase();
  // Economy: ~500₪/day daily, ~5000₪/week weekly
  // Tiers: Resources (days), Equipment (weeks), God-tier (months)
  const defaults = [
    // ─── Resources ──────────────────────────────────
    {
      guildId,
      name: 'Набор Алмазов (16 шт)',
      description: 'Чистейшие драгоценные алмазы для крафта инструментов',
      priceShekels: 2000,        // ~4 дня
      rconCommand: 'give {username} minecraft:diamond 16',
      iconEmoji: '💎',
      category: 'resources',
    },
    {
      guildId,
      name: 'Незеритовые Слитки (4 шт)',
      description: 'Редчайший незеритовый сплав для улучшения экипировки',
      priceShekels: 8000,        // ~2.5 недели
      rconCommand: 'give {username} minecraft:netherite_ingot 4',
      iconEmoji: '🧱',
      category: 'resources',
    },
    {
      guildId,
      name: 'Незеритовый Блок (1 шт)',
      description: 'Массивный блок драгоценнейшего незерита',
      priceShekels: 30000,       // ~6 недель
      rconCommand: 'give {username} minecraft:netherite_block 1',
      iconEmoji: '🌟',
      category: 'resources',
    },
    {
      guildId,
      name: 'Яблоки Бессмертия (8 шт)',
      description: 'Зачарованные золотые яблоки для битв и восстановления',
      priceShekels: 12000,       // ~2.5 недели
      rconCommand: 'give {username} minecraft:enchanted_golden_apple 8',
      iconEmoji: '🍎',
      category: 'resources',
    },
    {
      guildId,
      name: 'Изумруды (32 шт)',
      description: 'Валюта торговцев — для выгодных сделок с жителями',
      priceShekels: 3000,        // ~6 дней
      rconCommand: 'give {username} minecraft:emerald 32',
      iconEmoji: '💚',
      category: 'resources',
    },
    {
      guildId,
      name: 'Elytra (1 шт)',
      description: 'Легендарные крылья для полётов над миром',
      priceShekels: 35000,       // ~7 недель
      rconCommand: 'give {username} minecraft:elytra 1',
      iconEmoji: '🦋',
      category: 'resources',
    },

    // ─── Equipment ──────────────────────────────────
    {
      guildId,
      name: 'Незеритовый Комплект Воина',
      description: 'Полный сет незеритовой брони + незеритовый меч',
      priceShekels: 20000,       // ~4 недели
      rconCommand: 'give {username} minecraft:netherite_helmet 1; give {username} minecraft:netherite_chestplate 1; give {username} minecraft:netherite_leggings 1; give {username} minecraft:netherite_boots 1; give {username} minecraft:netherite_sword 1',
      iconEmoji: '🛡️',
      category: 'equipment',
    },
    {
      guildId,
      name: 'Незеритовый Инструментальный Набор',
      description: 'Кирка + лопата + топор + мотыга из незерита',
      priceShekels: 15000,       // ~3 недели
      rconCommand: 'give {username} minecraft:netherite_pickaxe 1; give {username} minecraft:netherite_shovel 1; give {username} minecraft:netherite_axe 1; give {username} minecraft:netherite_hoe 1',
      iconEmoji: '⛏️',
      category: 'equipment',
    },
    {
      guildId,
      name: 'Лук Снайпера (Сила V + Бесконечность)',
      description: 'Легендарный лук с максимальными чарами на урон',
      priceShekels: 12000,       // ~2.5 недели
      rconCommand: 'give {username} minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5,"minecraft:infinity":1,"minecraft:unbreaking":3,"minecraft:mending":1}}] 1',
      iconEmoji: '🏹',
      category: 'equipment',
    },
    {
      guildId,
      name: 'Тотем Бессмертия (3 шт)',
      description: 'Защита от смерти — незаменимая страховка',
      priceShekels: 18000,       // ~3.5 недели
      rconCommand: 'give {username} minecraft:totem_of_undying 3',
      iconEmoji: '🏺',
      category: 'equipment',
    },

    // ─── Create Mod ─────────────────────────────────
    {
      guildId,
      name: 'Набор Шестерён (8 малых + 8 больших + 16 валов)',
      description: 'Шестерни и валы для запуска кинематики Create',
      priceShekels: 1500,        // ~3 дня
      rconCommand: 'give {username} create:cogwheel 8; give {username} create:large_cogwheel 8; give {username} create:shaft 16',
      iconEmoji: '⚙️',
      category: 'create',
    },
    {
      guildId,
      name: 'Латунные Слитки Create (16 шт)',
      description: 'Высокоточная латунь для логистики и умных воронок',
      priceShekels: 2500,        // ~5 дней
      rconCommand: 'give {username} create:brass_ingot 16',
      iconEmoji: '🟡',
      category: 'create',
    },
    {
      guildId,
      name: 'Горелка Блейза + Стержни (1 + 8 шт)',
      description: 'Blaze Burner для супернагрева и варки металлов',
      priceShekels: 4000,        // ~8 дней
      rconCommand: 'give {username} create:blaze_burner 1; give {username} minecraft:blaze_rod 8',
      iconEmoji: '🔥',
      category: 'create',
    },
    {
      guildId,
      name: 'Поездной Набор (64 рельсы + 8 корпусов + контроллер)',
      description: 'Полный комплект для запуска вашего первого поезда',
      priceShekels: 8000,        // ~1.5 недели
      rconCommand: 'give {username} create:track 64; give {username} create:railway_casing 8; give {username} create:controls 1',
      iconEmoji: '🚂',
      category: 'create',
    },
    {
      guildId,
      name: 'Механический Смешиватель + Таз',
      description: 'Для сложных рецептов варки и замешивания в Create',
      priceShekels: 3500,        // ~7 дней
      rconCommand: 'give {username} create:mechanical_mixer 1; give {username} create:basin 1',
      iconEmoji: '🥣',
      category: 'create',
    },
    {
      guildId,
      name: 'Конвейерные Ленты Create (32 шт)',
      description: 'Настоящие конвейеры для автоматических заводов',
      priceShekels: 2000,        // ~4 дня
      rconCommand: 'give {username} create:belt 32',
      iconEmoji: '📦',
      category: 'create',
    },

    // ─── Other Mods ─────────────────────────────────
    {
      guildId,
      name: 'Железный Сундук XL (Iron Chests)',
      description: 'Большой сундук из мода Iron Chests — ёмкость 108 слотов',
      priceShekels: 2500,        // ~5 дней
      rconCommand: 'give {username} ironfurnaces:iron_chest 1',
      iconEmoji: '🗃️',
      category: 'mods',
    },
    {
      guildId,
      name: 'Ящик для Хранения (Storage Drawers, 2х2)',
      description: 'Компактный ящик для массового хранения предметов',
      priceShekels: 3000,        // ~6 дней
      rconCommand: 'give {username} storagedrawers:oak_full_drawers_4 1',
      iconEmoji: '🗄️',
      category: 'mods',
    },
    {
      guildId,
      name: 'Рюкзак (Sophisticated Backpacks)',
      description: 'Вместительный рюкзак с апгрейдами для путешественника',
      priceShekels: 6000,        // ~1.5 недели
      rconCommand: 'give {username} sophisticatedbackpacks:backpack 1',
      iconEmoji: '🎒',
      category: 'mods',
    },
    {
      guildId,
      name: 'Набор еды Farmer\'s Delight',
      description: 'Стьюти + Жареная курица + Фаршированная тыква',
      priceShekels: 2000,        // ~4 дня
      rconCommand: 'give {username} farmersdelight:comfort_stew 8; give {username} farmersdelight:roast_chicken 8; give {username} farmersdelight:stuffed_pumpkin 4',
      iconEmoji: '🍲',
      category: 'mods',
    },
    {
      guildId,
      name: 'Сумка-Тоут (Supplementaries)',
      description: 'Стильная холщовая сумка из мода Supplementaries',
      priceShekels: 1500,        // ~3 дня
      rconCommand: 'give {username} supplementaries:tote_bag 1',
      iconEmoji: '👜',
      category: 'mods',
    },
    {
      guildId,
      name: 'Алхимический Набор (Apotheosis)',
      description: 'Tome of Rectification + Gem Dust + Infusion Stone',
      priceShekels: 12000,       // ~2.5 недели
      rconCommand: 'give {username} apotheosis:tome_of_rectification 1; give {username} apotheosis:gem_dust 16; give {username} apotheosis:infusion_stone 4',
      iconEmoji: '📖',
      category: 'mods',
    },

    // ─── God Tier / OP Items ─────────────────────────
    {
      guildId,
      name: 'Меч Разрушителя (Sharpness X, Looting V)',
      description: 'Читерский меч со 10-м уровнем Остроты и 5-м Добычи',
      priceShekels: 80000,       // ~16 недель / 4 месяца
      rconCommand: 'give {username} minecraft:netherite_sword[minecraft:enchantments={levels:{"minecraft:sharpness":10,"minecraft:looting":5,"minecraft:unbreaking":5,"minecraft:sweeping_edge":3}}] 1',
      iconEmoji: '⚔️',
      category: 'god_tier',
    },
    {
      guildId,
      name: 'Кирка Богов (Efficiency X, Fortune V, Mending)',
      description: 'Мгновенное разрушение любых блоков и удвоение руды',
      priceShekels: 65000,       // ~13 недель / 3 месяца
      rconCommand: 'give {username} minecraft:netherite_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":10,"minecraft:fortune":5,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1',
      iconEmoji: '⛏️',
      category: 'god_tier',
    },
    {
      guildId,
      name: 'Нагрудник Бессмертия (Protection X, Thorns III)',
      description: 'Абсолютная непробиваемость и отражение урона',
      priceShekels: 120000,      // ~24 недели / 6 месяцев
      rconCommand: 'give {username} minecraft:netherite_chestplate[minecraft:enchantments={levels:{"minecraft:protection":10,"minecraft:thorns":3,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1',
      iconEmoji: '👑',
      category: 'god_tier',
    },
    {
      guildId,
      name: 'Полная Броня Богов (Protection X на весь сет)',
      description: 'Шлем + нагрудник + поножи + ботинки — всё с Protection X',
      priceShekels: 500000,      // ~100 недель — легендарная цель!
      rconCommand: 'give {username} minecraft:netherite_helmet[minecraft:enchantments={levels:{"minecraft:protection":10,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1; give {username} minecraft:netherite_chestplate[minecraft:enchantments={levels:{"minecraft:protection":10,"minecraft:thorns":3,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1; give {username} minecraft:netherite_leggings[minecraft:enchantments={levels:{"minecraft:protection":10,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1; give {username} minecraft:netherite_boots[minecraft:enchantments={levels:{"minecraft:protection":10,"minecraft:feather_falling":10,"minecraft:unbreaking":5,"minecraft:mending":1}}] 1',
      iconEmoji: '🌠',
      category: 'god_tier',
    },
  ];

  // Remove existing items and re-seed clean
  await db.minecraftShopItem.deleteMany({ where: { guildId } });

  for (const item of defaults) {
    await db.minecraftShopItem.create({ data: item });
  }

  return db.minecraftShopItem.findMany({
    where: { guildId, isActive: true },
    orderBy: [{ category: 'asc' }, { priceShekels: 'asc' }],
  }) as Promise<MinecraftShopItemData[]>;
}