-- CreateTable
CREATE TABLE "guild_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ru',
    "prefix" TEXT NOT NULL DEFAULT '/',
    "welcomeChannelId" TEXT,
    "ticketChannelId" TEXT,
    "autoRoleId" TEXT,
    "recruitRoleId" TEXT,
    "memberRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ru',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_logs" (
    "id" TEXT NOT NULL,
    "moduleName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "module_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "newsChannelId" TEXT,
    "logChannelId" TEXT,
    "voiceRateBase" INTEGER NOT NULL DEFAULT 50,
    "voiceRatePb" INTEGER NOT NULL DEFAULT 200,
    "voiceMinMembers" INTEGER NOT NULL DEFAULT 2,
    "voiceIntervalMs" INTEGER NOT NULL DEFAULT 600000,
    "dailyCooldown" BIGINT NOT NULL DEFAULT 86400000,
    "weeklyCooldown" BIGINT NOT NULL DEFAULT 604800000,
    "workCooldown" BIGINT NOT NULL DEFAULT 14400000,
    "crimeCooldown" BIGINT NOT NULL DEFAULT 28800000,
    "begCooldown" BIGINT NOT NULL DEFAULT 30000,
    "dailyBase" INTEGER NOT NULL DEFAULT 500,
    "dailyStreakAdd" INTEGER NOT NULL DEFAULT 50,
    "dailyStreakMax" INTEGER NOT NULL DEFAULT 500,
    "weeklyBase" INTEGER NOT NULL DEFAULT 5000,
    "weeklyPbBonus" INTEGER NOT NULL DEFAULT 2000,
    "workMin" INTEGER NOT NULL DEFAULT 200,
    "workMax" INTEGER NOT NULL DEFAULT 800,
    "crimeMin" INTEGER NOT NULL DEFAULT 0,
    "crimeMax" INTEGER NOT NULL DEFAULT 2000,
    "crimeSuccessRate" INTEGER NOT NULL DEFAULT 60,
    "crimeFine" INTEGER NOT NULL DEFAULT 500,
    "begMin" INTEGER NOT NULL DEFAULT 5,
    "begMax" INTEGER NOT NULL DEFAULT 100,
    "transferTax" INTEGER NOT NULL DEFAULT 5,
    "bankWithdrawTax" INTEGER NOT NULL DEFAULT 2,
    "casinoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "casinoMaxBet" INTEGER NOT NULL DEFAULT 50000,
    "casinoMinBet" INTEGER NOT NULL DEFAULT 50,
    "slotsJackpot" INTEGER NOT NULL DEFAULT 1000,
    "pbRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pbVoiceChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pbVoiceCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "robCooldown" BIGINT NOT NULL DEFAULT 14400000,
    "robEnabled" BOOLEAN NOT NULL DEFAULT true,
    "robFine" INTEGER NOT NULL DEFAULT 500,
    "robMaxPercent" INTEGER NOT NULL DEFAULT 30,
    "robMinSteal" INTEGER NOT NULL DEFAULT 100,
    "robSuccessRate" INTEGER NOT NULL DEFAULT 45,
    "heistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "heistCooldownInit" BIGINT NOT NULL DEFAULT 86400000,
    "heistCooldownMember" BIGINT NOT NULL DEFAULT 43200000,
    "heistAssembleMs" INTEGER NOT NULL DEFAULT 300000,
    "heistMinMembers" INTEGER NOT NULL DEFAULT 2,
    "heistMaxMembers" INTEGER NOT NULL DEFAULT 4,
    "heistBaseChance" INTEGER NOT NULL DEFAULT 60,
    "heistChancePerMember" INTEGER NOT NULL DEFAULT 15,
    "heistSafePenalty" INTEGER NOT NULL DEFAULT 20,
    "heistMinPercent" INTEGER NOT NULL DEFAULT 8,
    "heistMaxPercent" INTEGER NOT NULL DEFAULT 15,
    "heistFine" INTEGER NOT NULL DEFAULT 1000,
    "heistMinVictimBank" INTEGER NOT NULL DEFAULT 2000,
    "wantedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "wantedDecayMs" BIGINT NOT NULL DEFAULT 172800000,
    "wantedCaptureMin" INTEGER NOT NULL DEFAULT 3,
    "wantedCaptureChance" INTEGER NOT NULL DEFAULT 70,
    "wantedVictimBonus" INTEGER NOT NULL DEFAULT 50,
    "wantedCaptureCooldown" BIGINT NOT NULL DEFAULT 21600000,
    "wantedCaptureReward" INTEGER NOT NULL DEFAULT 20,
    "wantedCaptureFine" INTEGER NOT NULL DEFAULT 750,
    "policeRoleId" TEXT,
    "govStaffRoleId" TEXT,
    "dirtyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dirtyExpireMs" BIGINT NOT NULL DEFAULT 86400000,
    "dirtyLaunderTax" INTEGER NOT NULL DEFAULT 15,
    "safeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "safeDurationMs" BIGINT NOT NULL DEFAULT 604800000,
    "safePrice" INTEGER NOT NULL DEFAULT 10000,
    "safeMode" TEXT NOT NULL DEFAULT 'partial',
    "lockpickEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lockpickPrice" INTEGER NOT NULL DEFAULT 3000,
    "lockpickBonus" INTEGER NOT NULL DEFAULT 20,
    "shopEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marketEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marketSubmitFee" INTEGER NOT NULL DEFAULT 5000,
    "marketCommissionPct" INTEGER NOT NULL DEFAULT 80,
    "marketModChannelId" TEXT,
    "marketMaxPerUser" INTEGER NOT NULL DEFAULT 3,
    "marketMaxPrice" INTEGER NOT NULL DEFAULT 500000,
    "marketMinPrice" INTEGER NOT NULL DEFAULT 1000,
    "eventName" TEXT NOT NULL DEFAULT '',
    "eventEndsAt" TIMESTAMP(3),
    "eventEarnMul" INTEGER NOT NULL DEFAULT 100,
    "eventRobMul" INTEGER NOT NULL DEFAULT 100,
    "eventWantedMul" INTEGER NOT NULL DEFAULT 100,
    "eventWeekendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "eventWeekendEarnMul" INTEGER NOT NULL DEFAULT 150,
    "eventWeekendRobMul" INTEGER NOT NULL DEFAULT 150,
    "leaderboardChannelId" TEXT,
    "leaderboardMessageId" TEXT,
    "welcomeBonus" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "economy_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_profiles" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wallet" INTEGER NOT NULL DEFAULT 0,
    "bank" INTEGER NOT NULL DEFAULT 0,
    "bankLimit" INTEGER NOT NULL DEFAULT 5000,
    "dailyStreak" INTEGER NOT NULL DEFAULT 0,
    "bestDailyStreak" INTEGER NOT NULL DEFAULT 0,
    "lastDaily" TIMESTAMP(3),
    "lastWeekly" TIMESTAMP(3),
    "lastWork" TIMESTAMP(3),
    "lastCrime" TIMESTAMP(3),
    "lastBeg" TIMESTAMP(3),
    "lastRob" TIMESTAMP(3),
    "totalEarned" BIGINT NOT NULL DEFAULT 0,
    "totalSpent" BIGINT NOT NULL DEFAULT 0,
    "pbVoiceSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastHeistInit" TIMESTAMP(3),
    "lastHeistMember" TIMESTAMP(3),
    "wantedStars" INTEGER NOT NULL DEFAULT 0,
    "wantedNextDecay" TIMESTAMP(3),
    "lastCapture" TIMESTAMP(3),
    "dirtyAmount" INTEGER NOT NULL DEFAULT 0,
    "dirtyClearAt" TIMESTAMP(3),
    "safeUntil" TIMESTAMP(3),
    "lockpickReady" BOOLEAN NOT NULL DEFAULT false,
    "maskReady" BOOLEAN NOT NULL DEFAULT false,
    "blackMarketSlots" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "economy_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_transactions" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "targetId" TEXT,
    "details" TEXT,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_heists" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "victimId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'assembling',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "stolenAmount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_heists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_heist_members" (
    "id" TEXT NOT NULL,
    "heistId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payout" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "economy_heist_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_items" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "durationHours" INTEGER NOT NULL DEFAULT 0,
    "maxStock" INTEGER NOT NULL DEFAULT -1,
    "currentStock" INTEGER NOT NULL DEFAULT -1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "configId" TEXT NOT NULL,
    "perks" JSONB,
    "sellerId" TEXT,
    "commissionPct" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_role_requests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "proposedPrice" INTEGER NOT NULL,
    "durationHours" INTEGER NOT NULL DEFAULT 0,
    "perks" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "feePaid" INTEGER NOT NULL DEFAULT 0,
    "commissionPct" INTEGER NOT NULL DEFAULT 80,
    "createdRoleId" TEXT,
    "itemId" TEXT,
    "modMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "shop_role_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_purchases" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regbattle_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "masterChannelId" TEXT,
    "categoryId" TEXT,
    "announceChannelId" TEXT,
    "reserveChannelId" TEXT,
    "pingRoleId" TEXT,
    "inSquadRoleId" TEXT,
    "commanderRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "muteRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "squadSize" INTEGER NOT NULL DEFAULT 8,
    "airSize" INTEGER NOT NULL DEFAULT 4,
    "pingEscalateAfter" INTEGER NOT NULL DEFAULT 6,
    "playedMinMinutes" INTEGER NOT NULL DEFAULT 15,
    "playedResetHour" INTEGER NOT NULL DEFAULT 23,
    "playedTodayRoleId" TEXT,
    "reprimandAnnulRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reprimandChannelId" TEXT,
    "reprimandTypeRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reprimandDurationDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regbattle_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regbattle_squads" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "voiceChannelId" TEXT NOT NULL,
    "airChannelId" TEXT,
    "panelMessageId" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configId" TEXT NOT NULL,

    CONSTRAINT "regbattle_squads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reprimands" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "offenderId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "typeRoleId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "messageId" TEXT,
    "channelId" TEXT,
    "appealCategoryId" TEXT,
    "appealTextId" TEXT,
    "appealVoiceId" TEXT,
    "annulledById" TEXT,
    "annulledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "nextAppealAt" TIMESTAMP(3),
    "appealDecision" TEXT,
    "appealDecisionById" TEXT,
    "appealDecisionReason" TEXT,
    "appealDecisionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reprimands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tempvoice_generators" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "interfaceId" TEXT,
    "defaultName" TEXT NOT NULL DEFAULT '{nickname}',
    "defaultLimit" INTEGER NOT NULL DEFAULT 0,
    "defaultBitrate" INTEGER NOT NULL DEFAULT 64000,
    "defaultRegion" TEXT NOT NULL DEFAULT 'auto',
    "initialState" TEXT NOT NULL DEFAULT 'unlocked',
    "maxChannelsPerUser" INTEGER NOT NULL DEFAULT 1,
    "maxUserLimit" INTEGER NOT NULL DEFAULT 99,
    "minUserLimit" INTEGER NOT NULL DEFAULT 0,
    "maxBitrate" INTEGER NOT NULL DEFAULT 96000,
    "minBitrate" INTEGER NOT NULL DEFAULT 8000,
    "boosterPerks" BOOLEAN NOT NULL DEFAULT true,
    "immuneRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rewardAnnounceChId" TEXT,
    "rewardRoleId" TEXT,
    "rewardThresholdMin" INTEGER NOT NULL DEFAULT 3000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tempvoice_generators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tempvoice_channels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "generatorId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'unlocked',
    "controlMsgId" TEXT,
    "nameChanges" INTEGER NOT NULL DEFAULT 0,
    "lastNameChange" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tempvoice_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tempvoice_blocked" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "tempvoice_blocked_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tempvoice_trusted" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "tempvoice_trusted_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tempvoice_user_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "savedName" TEXT,
    "savedLimit" INTEGER,
    "savedBitrate" INTEGER,
    "savedRegion" TEXT,
    "rewardGranted" BOOLEAN NOT NULL DEFAULT false,
    "totalVoiceMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tempvoice_user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "panelChannelId" TEXT,
    "panelMessageId" TEXT,
    "reviewChannelId" TEXT,
    "logChannelId" TEXT,
    "vacationRoleId" TEXT,
    "removeRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewerRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pingRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDurationDays" INTEGER NOT NULL DEFAULT 30,
    "quickDurationH" INTEGER NOT NULL DEFAULT 12,
    "primeTimeStart" INTEGER NOT NULL DEFAULT 17,
    "primeTimeEnd" INTEGER NOT NULL DEFAULT 1,
    "primeTimeBuffer" INTEGER NOT NULL DEFAULT 1,
    "imageUrl" TEXT,
    "autoDenyHours" INTEGER NOT NULL DEFAULT 8,
    "cooldownDays" INTEGER NOT NULL DEFAULT 3,
    "maxPerMonth" INTEGER NOT NULL DEFAULT 5,
    "maxQuickPerWeek" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vacation_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_requests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'regular',
    "reason" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewMessageId" TEXT,
    "savedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "configId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vacation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ns_vacations" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "savedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "reason" TEXT,
    "messageId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ns_vacations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "br_tech_entries" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "br" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "br_tech_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "br_panels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "panelChannelId" TEXT,
    "panelMessageId" TEXT,
    "defaultBr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "br_panels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "applicationChannelId" TEXT,
    "reportChannelId" TEXT,
    "pollChannelId" TEXT,
    "leaderboardChannelId" TEXT,
    "leaderboardMessageId" TEXT,
    "approverRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "baseRoleId" TEXT,
    "minSize" INTEGER NOT NULL DEFAULT 10,
    "inviteTimeoutH" INTEGER NOT NULL DEFAULT 24,
    "formationDays" INTEGER NOT NULL DEFAULT 7,
    "disbandGraceDays" INTEGER NOT NULL DEFAULT 30,
    "pollAutoHoursBefore" INTEGER NOT NULL DEFAULT 2,
    "reportTimeoutH" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'forming',
    "disbandWarningAt" TIMESTAMP(3),
    "configId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invites" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_applications" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_sessions" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "squadNumber" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reportedById" TEXT,
    "reportedPR" INTEGER,
    "reportedPlace" INTEGER,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_seasons" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalPR" INTEGER NOT NULL DEFAULT 0,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalPlace" INTEGER NOT NULL DEFAULT 0,
    "bestPlace" INTEGER NOT NULL DEFAULT 300,
    "attendance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_polls" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "messageId" TEXT,
    "channelId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'manual',
    "scheduledAt" TIMESTAMP(3),
    "yesUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "noUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "voteTimes" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "left_members" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leftAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "left_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_raids" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalPool" INTEGER NOT NULL DEFAULT 0,
    "maxHp" INTEGER NOT NULL DEFAULT 0,
    "currentHp" INTEGER NOT NULL DEFAULT 0,
    "channelId" TEXT,
    "messageId" TEXT,
    "startedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastHitUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_raids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_raid_participants" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "damage" INTEGER NOT NULL DEFAULT 0,
    "payout" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_raid_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_raid_abandoned" (
    "id" TEXT NOT NULL,
    "raidId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,

    CONSTRAINT "economy_raid_abandoned_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowed_guilds" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allowed_guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_inventory_items" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "description" VARCHAR(255),
    "perks" JSONB,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economy_black_market_listings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" INTEGER NOT NULL,
    "description" VARCHAR(255),
    "perks" JSONB,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "economy_black_market_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_item_requests" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "perks" JSONB,
    "feePaid" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "modMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "custom_item_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guild_settings_guildId_key" ON "guild_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "users_discordId_key" ON "users"("discordId");

-- CreateIndex
CREATE UNIQUE INDEX "economy_configs_guildId_key" ON "economy_configs"("guildId");

-- CreateIndex
CREATE INDEX "economy_profiles_guildId_idx" ON "economy_profiles"("guildId");

-- CreateIndex
CREATE INDEX "economy_profiles_guildId_wantedStars_idx" ON "economy_profiles"("guildId", "wantedStars");

-- CreateIndex
CREATE UNIQUE INDEX "economy_profiles_guildId_userId_key" ON "economy_profiles"("guildId", "userId");

-- CreateIndex
CREATE INDEX "economy_transactions_guildId_userId_idx" ON "economy_transactions"("guildId", "userId");

-- CreateIndex
CREATE INDEX "economy_transactions_createdAt_idx" ON "economy_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "economy_transactions_profileId_idx" ON "economy_transactions"("profileId");

-- CreateIndex
CREATE INDEX "economy_heists_guildId_status_idx" ON "economy_heists"("guildId", "status");

-- CreateIndex
CREATE INDEX "economy_heists_guildId_initiatorId_idx" ON "economy_heists"("guildId", "initiatorId");

-- CreateIndex
CREATE INDEX "economy_heists_expiresAt_idx" ON "economy_heists"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "economy_heist_members_heistId_userId_key" ON "economy_heist_members"("heistId", "userId");

-- CreateIndex
CREATE INDEX "shop_items_guildId_idx" ON "shop_items"("guildId");

-- CreateIndex
CREATE INDEX "shop_items_sellerId_idx" ON "shop_items"("sellerId");

-- CreateIndex
CREATE INDEX "shop_items_configId_idx" ON "shop_items"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_items_guildId_roleId_key" ON "shop_items"("guildId", "roleId");

-- CreateIndex
CREATE INDEX "shop_role_requests_guildId_status_idx" ON "shop_role_requests"("guildId", "status");

-- CreateIndex
CREATE INDEX "shop_role_requests_sellerId_idx" ON "shop_role_requests"("sellerId");

-- CreateIndex
CREATE INDEX "shop_purchases_guildId_userId_idx" ON "shop_purchases"("guildId", "userId");

-- CreateIndex
CREATE INDEX "shop_purchases_expiresAt_idx" ON "shop_purchases"("expiresAt");

-- CreateIndex
CREATE INDEX "shop_purchases_itemId_idx" ON "shop_purchases"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "regbattle_configs_guildId_key" ON "regbattle_configs"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "regbattle_squads_voiceChannelId_key" ON "regbattle_squads"("voiceChannelId");

-- CreateIndex
CREATE INDEX "regbattle_squads_guildId_idx" ON "regbattle_squads"("guildId");

-- CreateIndex
CREATE INDEX "reprimands_guildId_idx" ON "reprimands"("guildId");

-- CreateIndex
CREATE INDEX "reprimands_offenderId_idx" ON "reprimands"("offenderId");

-- CreateIndex
CREATE INDEX "reprimands_expiresAt_idx" ON "reprimands"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "tempvoice_generators_channelId_key" ON "tempvoice_generators"("channelId");

-- CreateIndex
CREATE INDEX "tempvoice_generators_guildId_idx" ON "tempvoice_generators"("guildId");

-- CreateIndex
CREATE INDEX "tempvoice_channels_guildId_idx" ON "tempvoice_channels"("guildId");

-- CreateIndex
CREATE INDEX "tempvoice_channels_ownerId_idx" ON "tempvoice_channels"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "tempvoice_blocked_channelId_userId_key" ON "tempvoice_blocked"("channelId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tempvoice_trusted_channelId_userId_key" ON "tempvoice_trusted"("channelId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tempvoice_user_settings_userId_guildId_key" ON "tempvoice_user_settings"("userId", "guildId");

-- CreateIndex
CREATE UNIQUE INDEX "vacation_configs_guildId_key" ON "vacation_configs"("guildId");

-- CreateIndex
CREATE INDEX "vacation_requests_guildId_userId_idx" ON "vacation_requests"("guildId", "userId");

-- CreateIndex
CREATE INDEX "vacation_requests_status_idx" ON "vacation_requests"("status");

-- CreateIndex
CREATE INDEX "ns_vacations_guildId_userId_idx" ON "ns_vacations"("guildId", "userId");

-- CreateIndex
CREATE INDEX "ns_vacations_status_endDate_idx" ON "ns_vacations"("status", "endDate");

-- CreateIndex
CREATE INDEX "br_tech_entries_guildId_br_idx" ON "br_tech_entries"("guildId", "br");

-- CreateIndex
CREATE INDEX "br_tech_entries_guildId_br_category_idx" ON "br_tech_entries"("guildId", "br", "category");

-- CreateIndex
CREATE INDEX "br_tech_entries_guildId_name_idx" ON "br_tech_entries"("guildId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "br_panels_guildId_key" ON "br_panels"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "team_configs_guildId_key" ON "team_configs"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_roleId_key" ON "teams"("roleId");

-- CreateIndex
CREATE INDEX "teams_guildId_idx" ON "teams"("guildId");

-- CreateIndex
CREATE INDEX "teams_leaderId_idx" ON "teams"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_guildId_name_key" ON "teams"("guildId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_userId_key" ON "team_members"("userId");

-- CreateIndex
CREATE INDEX "team_members_teamId_idx" ON "team_members"("teamId");

-- CreateIndex
CREATE INDEX "team_invites_userId_idx" ON "team_invites"("userId");

-- CreateIndex
CREATE INDEX "team_invites_expiresAt_idx" ON "team_invites"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "team_invites_teamId_userId_key" ON "team_invites"("teamId", "userId");

-- CreateIndex
CREATE INDEX "team_applications_teamId_idx" ON "team_applications"("teamId");

-- CreateIndex
CREATE INDEX "team_applications_status_idx" ON "team_applications"("status");

-- CreateIndex
CREATE INDEX "team_sessions_teamId_idx" ON "team_sessions"("teamId");

-- CreateIndex
CREATE INDEX "team_sessions_guildId_startedAt_idx" ON "team_sessions"("guildId", "startedAt");

-- CreateIndex
CREATE INDEX "team_seasons_year_season_idx" ON "team_seasons"("year", "season");

-- CreateIndex
CREATE UNIQUE INDEX "team_seasons_teamId_season_year_key" ON "team_seasons"("teamId", "season", "year");

-- CreateIndex
CREATE INDEX "team_polls_teamId_idx" ON "team_polls"("teamId");

-- CreateIndex
CREATE INDEX "team_polls_status_idx" ON "team_polls"("status");

-- CreateIndex
CREATE INDEX "left_members_leftAt_idx" ON "left_members"("leftAt");

-- CreateIndex
CREATE UNIQUE INDEX "left_members_guildId_userId_key" ON "left_members"("guildId", "userId");

-- CreateIndex
CREATE INDEX "economy_raids_guildId_status_idx" ON "economy_raids"("guildId", "status");

-- CreateIndex
CREATE INDEX "economy_raid_participants_raidId_idx" ON "economy_raid_participants"("raidId");

-- CreateIndex
CREATE UNIQUE INDEX "economy_raid_participants_raidId_userId_key" ON "economy_raid_participants"("raidId", "userId");

-- CreateIndex
CREATE INDEX "economy_raid_abandoned_raidId_idx" ON "economy_raid_abandoned"("raidId");

-- CreateIndex
CREATE UNIQUE INDEX "economy_raid_abandoned_raidId_userId_key" ON "economy_raid_abandoned"("raidId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "allowed_guilds_guildId_key" ON "allowed_guilds"("guildId");

-- CreateIndex
CREATE INDEX "economy_inventory_items_guildId_userId_idx" ON "economy_inventory_items"("guildId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "economy_inventory_items_guildId_userId_itemKey_key" ON "economy_inventory_items"("guildId", "userId", "itemKey");

-- CreateIndex
CREATE INDEX "economy_black_market_listings_guildId_idx" ON "economy_black_market_listings"("guildId");

-- CreateIndex
CREATE INDEX "custom_item_requests_guildId_status_idx" ON "custom_item_requests"("guildId", "status");

-- CreateIndex
CREATE INDEX "custom_item_requests_creatorId_idx" ON "custom_item_requests"("creatorId");

-- AddForeignKey
ALTER TABLE "economy_transactions" ADD CONSTRAINT "economy_transactions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "economy_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economy_heist_members" ADD CONSTRAINT "economy_heist_members_heistId_fkey" FOREIGN KEY ("heistId") REFERENCES "economy_heists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_configId_fkey" FOREIGN KEY ("configId") REFERENCES "economy_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_purchases" ADD CONSTRAINT "shop_purchases_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "shop_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regbattle_squads" ADD CONSTRAINT "regbattle_squads_configId_fkey" FOREIGN KEY ("configId") REFERENCES "regbattle_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tempvoice_channels" ADD CONSTRAINT "tempvoice_channels_generatorId_fkey" FOREIGN KEY ("generatorId") REFERENCES "tempvoice_generators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tempvoice_blocked" ADD CONSTRAINT "tempvoice_blocked_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "tempvoice_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tempvoice_trusted" ADD CONSTRAINT "tempvoice_trusted_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "tempvoice_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_configId_fkey" FOREIGN KEY ("configId") REFERENCES "vacation_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_configId_fkey" FOREIGN KEY ("configId") REFERENCES "team_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_applications" ADD CONSTRAINT "team_applications_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_sessions" ADD CONSTRAINT "team_sessions_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_seasons" ADD CONSTRAINT "team_seasons_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_polls" ADD CONSTRAINT "team_polls_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economy_raid_participants" ADD CONSTRAINT "economy_raid_participants_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "economy_raids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economy_raid_abandoned" ADD CONSTRAINT "economy_raid_abandoned_raidId_fkey" FOREIGN KEY ("raidId") REFERENCES "economy_raids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
