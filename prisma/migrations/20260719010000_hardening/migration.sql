BEGIN;

-- New durable state used by cross-process idempotency and recovery workers.
CREATE TABLE "operation_claims" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "guildId" TEXT,
    "userId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "operation_claims_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "operation_claims_scope_guildId_userId_idx"
    ON "operation_claims"("scope", "guildId", "userId");
CREATE INDEX "operation_claims_expiresAt_idx" ON "operation_claims"("expiresAt");

ALTER TABLE "vacation_requests" ADD COLUMN "activeKey" TEXT;
ALTER TABLE "ns_vacations" ADD COLUMN "activeKey" TEXT;
ALTER TABLE "team_members" ADD COLUMN "guildId" TEXT;
ALTER TABLE "team_invites" ADD COLUMN "processingAt" TIMESTAMP(3);
ALTER TABLE "team_applications"
    ADD COLUMN "activeKey" TEXT,
    ADD COLUMN "channelId" TEXT,
    ADD COLUMN "processingAt" TIMESTAMP(3);
ALTER TABLE "team_sessions"
    ADD COLUMN "reportReminderAt" TIMESTAMP(3),
    ADD COLUMN "squadVoiceId" TEXT;
ALTER TABLE "team_polls"
    ADD COLUMN "activeKey" TEXT,
    ADD COLUMN "closedAt" TIMESTAMP(3),
    ADD COLUMN "dedupKey" TEXT,
    ADD COLUMN "notifiedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "uiClosedAt" TIMESTAMP(3);
ALTER TABLE "economy_raids" ADD COLUMN "activeKey" TEXT;
ALTER TABLE "economy_black_market_listings" ADD COLUMN "creatorId" TEXT;

CREATE TABLE "team_poll_votes" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "readyTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "team_poll_votes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "economy_black_market_deals" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "totalPrice" INTEGER NOT NULL,
    "description" VARCHAR(255),
    "perks" JSONB,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "creatorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "economy_black_market_deals_pkey" PRIMARY KEY ("id")
);

-- Team membership used to be globally unique by user. Backfill the guild from
-- the authoritative parent before replacing that constraint.
UPDATE "team_members" AS member
SET "guildId" = team."guildId"
FROM "teams" AS team
WHERE team."id" = member."teamId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "team_members" WHERE "guildId" IS NULL) THEN
    RAISE EXCEPTION 'Hardening migration: team_members contains an orphan row without a parent team';
  END IF;
END $$;

ALTER TABLE "team_members" ALTER COLUMN "guildId" SET NOT NULL;
DROP INDEX "team_members_userId_key";
CREATE UNIQUE INDEX "team_members_guildId_userId_key"
    ON "team_members"("guildId", "userId");

-- Discord-linked PB squads cannot be merged automatically without risking the
-- wrong channel/owner. Abort with an actionable diagnostic instead.
DO $$
DECLARE duplicate_key TEXT;
BEGIN
  SELECT "guildId" || ':' || "number" INTO duplicate_key
  FROM "regbattle_squads"
  GROUP BY "guildId", "number" HAVING COUNT(*) > 1 LIMIT 1;
  IF duplicate_key IS NOT NULL THEN
    RAISE EXCEPTION 'Hardening migration: duplicate PB squad number (%) must be resolved before deploy', duplicate_key;
  END IF;

  SELECT "guildId" || ':' || "ownerId" INTO duplicate_key
  FROM "regbattle_squads"
  GROUP BY "guildId", "ownerId" HAVING COUNT(*) > 1 LIMIT 1;
  IF duplicate_key IS NOT NULL THEN
    RAISE EXCEPTION 'Hardening migration: duplicate PB squad owner (%) must be resolved before deploy', duplicate_key;
  END IF;
END $$;

CREATE UNIQUE INDEX "regbattle_squads_guildId_number_key"
    ON "regbattle_squads"("guildId", "number");
CREATE UNIQUE INDEX "regbattle_squads_guildId_ownerId_key"
    ON "regbattle_squads"("guildId", "ownerId");

-- Merge role snapshots into one durable vacation record per member. The most
-- advanced state survives; superseded rows become terminal before UNIQUE.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "guildId", "userId"
    ORDER BY CASE "status"
      WHEN 'restoring' THEN 1 WHEN 'active' THEN 2
      WHEN 'activating' THEN 3 ELSE 4 END,
      "updatedAt" DESC, "id"
  ) AS rn
  FROM "vacation_requests"
  WHERE "status" IN ('pending', 'activating', 'active', 'restoring')
)
UPDATE "vacation_requests" AS survivor
SET "savedRoleIds" = ARRAY(
  SELECT DISTINCT role_id
  FROM "vacation_requests" AS source
  CROSS JOIN LATERAL unnest(COALESCE(source."savedRoleIds", ARRAY[]::TEXT[])) AS roles(role_id)
  WHERE source."guildId" = survivor."guildId"
    AND source."userId" = survivor."userId"
    AND source."status" IN ('pending', 'activating', 'active', 'restoring')
  ORDER BY role_id
)
FROM ranked
WHERE ranked."id" = survivor."id" AND ranked.rn = 1;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "guildId", "userId"
    ORDER BY CASE "status"
      WHEN 'restoring' THEN 1 WHEN 'active' THEN 2
      WHEN 'activating' THEN 3 ELSE 4 END,
      "updatedAt" DESC, "id"
  ) AS rn
  FROM "vacation_requests"
  WHERE "status" IN ('pending', 'activating', 'active', 'restoring')
)
UPDATE "vacation_requests" AS request
SET "status" = CASE WHEN request."status" = 'pending' THEN 'denied' ELSE 'completed' END,
    "endDate" = COALESCE(request."endDate", CURRENT_TIMESTAMP),
    "activeKey" = NULL
FROM ranked
WHERE ranked."id" = request."id" AND ranked.rn > 1;

-- NS shield and troll share one role-mutation slot; informational vacations
-- use a separate slot. Merge duplicate snapshots before terminalising extras.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "guildId", "userId", CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END
    ORDER BY CASE "status"
      WHEN 'restoring' THEN 1 WHEN 'active' THEN 2 WHEN 'activating' THEN 3 ELSE 4 END,
      "updatedAt" DESC, "id"
  ) AS rn
  FROM "ns_vacations"
  WHERE "status" IN ('activating', 'active', 'restoring')
)
UPDATE "ns_vacations" AS survivor
SET "savedRoleIds" = ARRAY(
  SELECT DISTINCT role_id
  FROM "ns_vacations" AS source
  CROSS JOIN LATERAL unnest(COALESCE(source."savedRoleIds", ARRAY[]::TEXT[])) AS roles(role_id)
  WHERE source."guildId" = survivor."guildId"
    AND source."userId" = survivor."userId"
    AND (CASE WHEN source."type" = 'vacation' THEN 'vacation' ELSE 'roles' END) =
        (CASE WHEN survivor."type" = 'vacation' THEN 'vacation' ELSE 'roles' END)
    AND source."status" IN ('activating', 'active', 'restoring')
  ORDER BY role_id
)
FROM ranked
WHERE ranked."id" = survivor."id" AND ranked.rn = 1;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "guildId", "userId", CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END
    ORDER BY CASE "status"
      WHEN 'restoring' THEN 1 WHEN 'active' THEN 2 WHEN 'activating' THEN 3 ELSE 4 END,
      "updatedAt" DESC, "id"
  ) AS rn
  FROM "ns_vacations"
  WHERE "status" IN ('activating', 'active', 'restoring')
)
UPDATE "ns_vacations" AS record
SET "status" = 'completed', "activeKey" = NULL
FROM ranked
WHERE ranked."id" = record."id" AND ranked.rn > 1;

-- Resolve legacy cross-table overlap. Exactly one role-restoring saga survives,
-- and it receives the union of every snapshot so no removed role is lost.
CREATE TEMP TABLE "_role_mutation_candidates" ON COMMIT DROP AS
SELECT candidate.*, ROW_NUMBER() OVER (
  PARTITION BY "guildId", "userId"
  ORDER BY priority, "updatedAt" DESC, "id"
) AS rn
FROM (
  SELECT 'regular'::TEXT AS source, "id", "guildId", "userId", "updatedAt",
    CASE "status" WHEN 'restoring' THEN 1 WHEN 'active' THEN 2
      WHEN 'activating' THEN 3 ELSE 4 END AS priority
  FROM "vacation_requests"
  WHERE "status" IN ('pending', 'activating', 'active', 'restoring')
  UNION ALL
  SELECT 'ns'::TEXT, "id", "guildId", "userId", "updatedAt",
    CASE "status" WHEN 'restoring' THEN 1 WHEN 'active' THEN 2
      WHEN 'activating' THEN 3 ELSE 4 END
  FROM "ns_vacations"
  WHERE "type" IN ('shield', 'troll') AND "status" IN ('activating', 'active', 'restoring')
) AS candidate;

UPDATE "vacation_requests" AS survivor
SET "savedRoleIds" = ARRAY(
  SELECT DISTINCT role_id FROM (
    SELECT unnest(COALESCE(survivor."savedRoleIds", ARRAY[]::TEXT[])) AS role_id
    UNION ALL
    SELECT unnest(COALESCE(record."savedRoleIds", ARRAY[]::TEXT[]))
    FROM "ns_vacations" AS record
    WHERE record."guildId" = survivor."guildId" AND record."userId" = survivor."userId"
      AND record."type" IN ('shield', 'troll')
      AND record."status" IN ('activating', 'active', 'restoring')
  ) AS merged WHERE role_id IS NOT NULL ORDER BY role_id
)
FROM "_role_mutation_candidates" AS winner
WHERE winner.source = 'regular' AND winner.rn = 1 AND winner."id" = survivor."id";

UPDATE "ns_vacations" AS survivor
SET "savedRoleIds" = ARRAY(
  SELECT DISTINCT role_id FROM (
    SELECT unnest(COALESCE(survivor."savedRoleIds", ARRAY[]::TEXT[])) AS role_id
    UNION ALL
    SELECT unnest(COALESCE(request."savedRoleIds", ARRAY[]::TEXT[]))
    FROM "vacation_requests" AS request
    WHERE request."guildId" = survivor."guildId" AND request."userId" = survivor."userId"
      AND request."status" IN ('pending', 'activating', 'active', 'restoring')
  ) AS merged WHERE role_id IS NOT NULL ORDER BY role_id
)
FROM "_role_mutation_candidates" AS winner
WHERE winner.source = 'ns' AND winner.rn = 1 AND winner."id" = survivor."id";

UPDATE "vacation_requests" AS request
SET "status" = CASE WHEN request."status" = 'pending' THEN 'denied' ELSE 'completed' END,
    "endDate" = COALESCE(request."endDate", CURRENT_TIMESTAMP), "activeKey" = NULL
FROM "_role_mutation_candidates" AS loser
WHERE loser.source = 'regular' AND loser.rn > 1 AND loser."id" = request."id";

UPDATE "ns_vacations" AS record
SET "status" = 'completed', "activeKey" = NULL
FROM "_role_mutation_candidates" AS loser
WHERE loser.source = 'ns' AND loser.rn > 1 AND loser."id" = record."id";

UPDATE "vacation_requests"
SET "activeKey" = "guildId" || ':' || "userId"
WHERE "status" IN ('pending', 'activating', 'active', 'restoring');
UPDATE "ns_vacations"
SET "activeKey" = "guildId" || ':' || "userId" || ':' ||
  CASE WHEN "type" = 'vacation' THEN 'vacation' ELSE 'roles' END
WHERE "status" IN ('activating', 'active', 'restoring');

CREATE UNIQUE INDEX "vacation_requests_activeKey_key" ON "vacation_requests"("activeKey");
CREATE UNIQUE INDEX "ns_vacations_activeKey_key" ON "ns_vacations"("activeKey");

-- Keep one actionable creation application per team. Old buttons are resolved
-- by team id at runtime, so superseded rows can be closed safely.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "teamId"
    ORDER BY ("messageId" IS NOT NULL) DESC, "createdAt" DESC, "id"
  ) AS rn
  FROM "team_applications"
  WHERE "status" IN ('pending', 'reviewing_approve', 'reviewing_reject')
)
UPDATE "team_applications" AS application
SET "status" = 'rejected', "reviewedAt" = COALESCE(application."reviewedAt", CURRENT_TIMESTAMP),
    "processingAt" = NULL, "activeKey" = NULL
FROM ranked
WHERE ranked."id" = application."id" AND ranked.rn > 1;

UPDATE "team_applications"
SET "activeKey" = "teamId"
WHERE "status" IN ('pending', 'reviewing_approve', 'reviewing_reject');
CREATE UNIQUE INDEX "team_applications_activeKey_key" ON "team_applications"("activeKey");

-- Preserve all legacy poll votes in the normalized, race-safe table.
INSERT INTO "team_poll_votes" ("id", "pollId", "userId", "vote", "readyTime", "createdAt", "updatedAt")
SELECT 'legacy_yes_' || md5(poll."id" || ':' || vote."userId"), poll."id", vote."userId", 'yes',
  CASE WHEN jsonb_typeof(poll."voteTimes") = 'object' THEN poll."voteTimes" ->> vote."userId" ELSE NULL END,
  poll."createdAt", CURRENT_TIMESTAMP
FROM "team_polls" AS poll
CROSS JOIN LATERAL unnest(COALESCE(poll."yesUserIds", ARRAY[]::TEXT[])) AS vote("userId")
ON CONFLICT DO NOTHING;

INSERT INTO "team_poll_votes" ("id", "pollId", "userId", "vote", "readyTime", "createdAt", "updatedAt")
SELECT 'legacy_no_' || md5(poll."id" || ':' || vote."userId"), poll."id", vote."userId", 'no', NULL,
  poll."createdAt", CURRENT_TIMESTAMP
FROM "team_polls" AS poll
CROSS JOIN LATERAL unnest(COALESCE(poll."noUserIds", ARRAY[]::TEXT[])) AS vote("userId")
WHERE NOT (vote."userId" = ANY(COALESCE(poll."yesUserIds", ARRAY[]::TEXT[])))
ON CONFLICT DO NOTHING;

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "teamId"
    ORDER BY ("messageId" IS NOT NULL) DESC, "createdAt" DESC, "id"
  ) AS rn
  FROM "team_polls" WHERE "status" = 'active'
)
UPDATE "team_polls" AS poll
SET "status" = 'closed', "closedAt" = COALESCE(poll."closedAt", CURRENT_TIMESTAMP), "activeKey" = NULL
FROM ranked
WHERE ranked."id" = poll."id" AND ranked.rn > 1;

UPDATE "team_polls" SET "activeKey" = "teamId" WHERE "status" = 'active';
UPDATE "team_polls" SET "closedAt" = COALESCE("closedAt", "createdAt") WHERE "status" = 'closed';

WITH auto_ranked AS (
  SELECT "id", "teamId", "createdAt", ROW_NUMBER() OVER (
    PARTITION BY "teamId", ("createdAt" + INTERVAL '3 hours')::DATE
    ORDER BY "createdAt" DESC, "id"
  ) AS rn
  FROM "team_polls" WHERE "type" = 'auto'
)
UPDATE "team_polls" AS poll
SET "dedupKey" = 'auto:' || ranked."teamId" || ':' ||
  to_char(ranked."createdAt" + INTERVAL '3 hours', 'YYYY-MM-DD')
FROM auto_ranked AS ranked
WHERE ranked."id" = poll."id" AND ranked.rn = 1;

CREATE INDEX "team_poll_votes_pollId_vote_idx" ON "team_poll_votes"("pollId", "vote");
CREATE UNIQUE INDEX "team_poll_votes_pollId_userId_key" ON "team_poll_votes"("pollId", "userId");
CREATE UNIQUE INDEX "team_polls_activeKey_key" ON "team_polls"("activeKey");
CREATE UNIQUE INDEX "team_polls_dedupKey_key" ON "team_polls"("dedupKey");
ALTER TABLE "team_poll_votes" ADD CONSTRAINT "team_poll_votes_pollId_fkey"
  FOREIGN KEY ("pollId") REFERENCES "team_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recover the active Teams↔PB link where legacy data makes it unambiguous.
WITH candidates AS (
  SELECT session."id", squad."voiceChannelId", ROW_NUMBER() OVER (
    PARTITION BY squad."voiceChannelId" ORDER BY session."startedAt" DESC, session."id"
  ) AS rn
  FROM "team_sessions" AS session
  JOIN "regbattle_squads" AS squad
    ON squad."guildId" = session."guildId" AND squad."number" = session."squadNumber"
  WHERE session."endedAt" IS NULL
)
UPDATE "team_sessions" AS session
SET "squadVoiceId" = candidates."voiceChannelId"
FROM candidates
WHERE candidates."id" = session."id" AND candidates.rn = 1;

CREATE UNIQUE INDEX "team_sessions_squadVoiceId_key" ON "team_sessions"("squadVoiceId");

-- Merge any legacy duplicate live raid pools and child accounting into one
-- winner per guild before adding activeKey.
CREATE TEMP TABLE "_live_raid_rank" ON COMMIT DROP AS
SELECT "id", "guildId", ROW_NUMBER() OVER (
  PARTITION BY "guildId"
  ORDER BY CASE "status" WHEN 'active' THEN 1 ELSE 2 END, "createdAt" DESC, "id"
) AS rn
FROM "economy_raids" WHERE "status" IN ('pending', 'active');

UPDATE "economy_raids" AS winner
SET "totalPool" = winner."totalPool" + COALESCE((
  SELECT SUM(extra."totalPool") FROM "economy_raids" AS extra
  JOIN "_live_raid_rank" AS rank ON rank."id" = extra."id"
  WHERE rank."guildId" = winner."guildId" AND rank.rn > 1
), 0)
FROM "_live_raid_rank" AS rank
WHERE rank."id" = winner."id" AND rank.rn = 1;

INSERT INTO "economy_raid_abandoned" ("id", "raidId", "userId", "balance")
SELECT 'legacy_abandoned_' || md5(winner."id" || ':' || abandoned."userId"),
  winner."id", abandoned."userId", SUM(abandoned."balance")
FROM "_live_raid_rank" AS loser
JOIN "economy_raid_abandoned" AS abandoned ON abandoned."raidId" = loser."id"
JOIN "_live_raid_rank" AS winner ON winner."guildId" = loser."guildId" AND winner.rn = 1
WHERE loser.rn > 1
GROUP BY winner."id", abandoned."userId"
ON CONFLICT ("raidId", "userId") DO UPDATE
SET "balance" = "economy_raid_abandoned"."balance" + EXCLUDED."balance";

INSERT INTO "economy_raid_participants" ("id", "raidId", "userId", "damage", "payout", "joinedAt")
SELECT 'legacy_participant_' || md5(winner."id" || ':' || participant."userId"),
  winner."id", participant."userId", SUM(participant."damage"), SUM(participant."payout"), MIN(participant."joinedAt")
FROM "_live_raid_rank" AS loser
JOIN "economy_raid_participants" AS participant ON participant."raidId" = loser."id"
JOIN "_live_raid_rank" AS winner ON winner."guildId" = loser."guildId" AND winner.rn = 1
WHERE loser.rn > 1
GROUP BY winner."id", participant."userId"
ON CONFLICT ("raidId", "userId") DO UPDATE
SET "damage" = "economy_raid_participants"."damage" + EXCLUDED."damage",
    "payout" = "economy_raid_participants"."payout" + EXCLUDED."payout";

DELETE FROM "economy_raid_abandoned" AS abandoned
USING "_live_raid_rank" AS loser
WHERE abandoned."raidId" = loser."id" AND loser.rn > 1;
DELETE FROM "economy_raid_participants" AS participant
USING "_live_raid_rank" AS loser
WHERE participant."raidId" = loser."id" AND loser.rn > 1;

UPDATE "economy_raids" AS raid
SET "status" = 'cancelled', "resolvedAt" = COALESCE(raid."resolvedAt", CURRENT_TIMESTAMP), "activeKey" = NULL
FROM "_live_raid_rank" AS loser
WHERE loser."id" = raid."id" AND loser.rn > 1;
UPDATE "economy_raids" AS raid
SET "activeKey" = raid."guildId"
FROM "_live_raid_rank" AS winner
WHERE winner."id" = raid."id" AND winner.rn = 1;

CREATE UNIQUE INDEX "economy_raids_activeKey_key" ON "economy_raids"("activeKey");

CREATE UNIQUE INDEX "economy_black_market_deals_listingId_key"
    ON "economy_black_market_deals"("listingId");
CREATE INDEX "economy_black_market_deals_guildId_status_idx"
    ON "economy_black_market_deals"("guildId", "status");
CREATE INDEX "economy_black_market_deals_buyerId_status_idx"
    ON "economy_black_market_deals"("buyerId", "status");
CREATE INDEX "economy_black_market_deals_expiresAt_idx"
    ON "economy_black_market_deals"("expiresAt");

COMMIT;
