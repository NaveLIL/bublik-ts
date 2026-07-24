BEGIN;

INSERT INTO "team_configs" ("id", "guildId", "updatedAt")
VALUES ('ci-team-config', 'ci-fixture-guild', '2026-07-19 09:00:00');

INSERT INTO "teams" (
  "id", "guildId", "name", "roleId", "leaderId", "configId", "updatedAt"
) VALUES (
  'ci-team', 'ci-fixture-guild', 'CI Fixture Team', 'ci-team-role',
  'ci-team-leader', 'ci-team-config', '2026-07-19 09:00:00'
);

INSERT INTO "team_members" ("id", "teamId", "userId")
VALUES ('ci-team-member', 'ci-team', 'ci-team-user');

INSERT INTO "team_invites" ("id", "teamId", "userId", "expiresAt")
VALUES ('ci-team-invite', 'ci-team', 'ci-team-invitee', '2026-07-21 09:00:00');

INSERT INTO "team_applications" ("id", "teamId", "status", "createdAt")
VALUES ('ci-team-application', 'ci-team', 'pending', '2026-07-19 09:00:00');

-- Two active polls exercise deterministic duplicate closure. Six distinct
-- normalized votes exercise yes/no precedence, ready times and timestamps.
INSERT INTO "team_polls" (
  "id", "teamId", "messageId", "type", "yesUserIds", "noUserIds",
  "voteTimes", "status", "createdAt"
) VALUES
  (
    'ci-poll-old', 'ci-team', NULL, 'auto',
    ARRAY['yes-user', 'both-user'], ARRAY['no-user', 'both-user'],
    '{"yes-user":"18:00","both-user":"19:00"}'::JSONB,
    'active', '2026-07-19 10:00:00'
  ),
  (
    'ci-poll-new', 'ci-team', 'ci-poll-message', 'auto',
    ARRAY['new-user'], ARRAY[]::TEXT[], '{"new-user":"20:00"}'::JSONB,
    'active', '2026-07-19 11:00:00'
  ),
  (
    'ci-poll-closed', 'ci-team', 'ci-closed-message', 'auto',
    ARRAY['closed-user'], ARRAY[]::TEXT[], '{}'::JSONB,
    'closed', '2026-07-18 10:00:00'
  ),
  (
    'ci-poll-manual', 'ci-team', 'ci-manual-message', 'manual',
    ARRAY[]::TEXT[], ARRAY['manual-no'], '{}'::JSONB,
    'closed', '2026-07-17 10:00:00'
  );

INSERT INTO "regbattle_configs" ("id", "guildId", "updatedAt")
VALUES ('ci-regbattle-config', 'ci-fixture-guild', '2026-07-19 09:00:00');

INSERT INTO "regbattle_squads" (
  "id", "guildId", "number", "voiceChannelId", "ownerId", "configId"
) VALUES (
  'ci-squad', 'ci-fixture-guild', 1, 'ci-squad-voice',
  'ci-squad-owner', 'ci-regbattle-config'
);

-- Only the latest live session may own the durable squad voice association.
INSERT INTO "team_sessions" (
  "id", "teamId", "guildId", "squadNumber", "startedAt", "createdAt"
) VALUES
  (
    'ci-session-old', 'ci-team', 'ci-fixture-guild', 1,
    '2026-07-19 10:00:00', '2026-07-19 10:00:00'
  ),
  (
    'ci-session-new', 'ci-team', 'ci-fixture-guild', 1,
    '2026-07-19 11:00:00', '2026-07-19 11:00:00'
  );

INSERT INTO "vacation_configs" ("id", "guildId", "updatedAt")
VALUES ('ci-vacation-config', 'ci-fixture-guild', '2026-07-19 09:00:00');

-- The active request wins and receives the canonical union of saved roles.
INSERT INTO "vacation_requests" (
  "id", "guildId", "userId", "reason", "durationMinutes", "status",
  "savedRoleIds", "configId", "createdAt", "updatedAt"
) VALUES
  (
    'ci-vacation-pending', 'ci-fixture-guild', 'ci-vacation-user',
    'pending fixture', 60, 'pending', ARRAY['role-b', 'role-a'],
    'ci-vacation-config', '2026-07-19 09:00:00', '2026-07-19 09:00:00'
  ),
  (
    'ci-vacation-active', 'ci-fixture-guild', 'ci-vacation-user',
    'active fixture', 120, 'active', ARRAY['role-c', 'role-a'],
    'ci-vacation-config', '2026-07-19 10:00:00', '2026-07-19 10:00:00'
  );

INSERT INTO "ns_vacations" (
  "id", "guildId", "userId", "type", "savedRoleIds", "status",
  "endDate", "createdAt", "updatedAt"
) VALUES
  (
    'ci-ns-vacation', 'ci-fixture-guild', 'ci-ns-info-user', 'vacation',
    ARRAY[]::TEXT[], 'active', '2026-07-21 10:00:00',
    '2026-07-19 10:00:00', '2026-07-19 10:00:00'
  ),
  (
    'ci-ns-shield', 'ci-fixture-guild', 'ci-ns-role-user', 'shield',
    ARRAY['role-z', 'role-y'], 'active', '2026-07-20 10:00:00',
    '2026-07-19 10:00:00', '2026-07-19 10:00:00'
  );

-- Duplicate live raids exercise deterministic merge and activeKey backfill.
INSERT INTO "economy_raids" (
  "id", "guildId", "status", "totalPool", "createdAt"
) VALUES
  ('ci-raid-pending', 'ci-fixture-guild', 'pending', 100, '2026-07-19 09:00:00'),
  ('ci-raid-active', 'ci-fixture-guild', 'active', 250, '2026-07-19 10:00:00');

INSERT INTO "economy_black_market_listings" (
  "id", "guildId", "sellerId", "itemKey", "name", "type", "quantity", "price"
) VALUES (
  'ci-listing', 'ci-fixture-guild', 'ci-seller', 'ci-item',
  'CI Item', 'item', 2, 50
);

COMMIT;
