-- Minecraft was initially introduced through db push on the live database.
-- Keep this migration idempotent so it can safely adopt that database while
-- also making a fresh migrate-deploy create the required tables.

CREATE TABLE IF NOT EXISTS "minecraft_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "statusChannelId" TEXT,
    "statusMessageId" TEXT,
    "serverAddress" TEXT NOT NULL DEFAULT 'play.erez.pro:25565',
    "serverName" TEXT NOT NULL DEFAULT 'EREZCRAFT',
    "lastStatus" TEXT,
    "lastAlertSentAt" TIMESTAMP(3),
    "whitelistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "playerRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "minecraft_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "minecraft_accounts" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "minecraftUsername" TEXT NOT NULL,
    "minecraftUuid" TEXT,
    "linkCode" TEXT,
    "linkCodeExpiresAt" TIMESTAMP(3),
    "isLinked" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3),
    "playtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "lastRewardAt" TIMESTAMP(3),
    "totalEarnedShekels" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "minecraft_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "minecraft_shop_items" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceShekels" INTEGER NOT NULL,
    "rconCommand" TEXT NOT NULL,
    "iconEmoji" TEXT NOT NULL DEFAULT '📦',
    "category" TEXT NOT NULL DEFAULT 'general',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "minecraft_shop_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "minecraft_configs_guildId_key"
    ON "minecraft_configs"("guildId");

CREATE UNIQUE INDEX IF NOT EXISTS "minecraft_accounts_guildId_discordId_key"
    ON "minecraft_accounts"("guildId", "discordId");

CREATE UNIQUE INDEX IF NOT EXISTS "minecraft_accounts_guildId_minecraftUsername_key"
    ON "minecraft_accounts"("guildId", "minecraftUsername");

CREATE INDEX IF NOT EXISTS "minecraft_accounts_guildId_isLinked_idx"
    ON "minecraft_accounts"("guildId", "isLinked");

CREATE INDEX IF NOT EXISTS "minecraft_shop_items_guildId_isActive_idx"
    ON "minecraft_shop_items"("guildId", "isActive");
