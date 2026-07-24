import assert from 'node:assert/strict';
import { Config } from '../src/config';
import { connectDatabase, disconnectDatabase, getDatabase } from '../src/core/Database';
import { connectRedis, disconnectRedis, getRedis } from '../src/core/Redis';
import {
  getAllowedGuildsList,
  initWhitelist,
  isGuildAllowed,
  removeAllowedGuild,
} from '../src/core/Whitelist';
import {
  attachCreatedTeamRole,
  claimMemberKick,
  createPendingTeamWithLeaderApplication,
  finalizeClaimedMemberKick,
} from '../src/modules/teams/database';
import {
  completeWelcomeRoleGrantIntent,
  prepareWelcomeRoleGrantIntent,
  readWelcomeRoleGrantIntent,
  recordWelcomeRoleGrantDispatch,
  replaceWelcomeRoleGrantIntent,
  WelcomeRoleGrantIntentFencedError,
} from '../src/modules/welcome/roleGrantIntent';

const TEST_GUILD_ID = 'integration-whitelist-guild';
const TEAM_GUILD_ID = 'integration-team-guild';
const LEADER_ID = 'integration-team-leader';
const MEMBER_ID = 'integration-team-member';
const WELCOME_GUILD_ID = 'integration-welcome-guild';
const WELCOME_USER_ID = 'integration-welcome-user';
const PENDING_ROLE_ID = `pending-team-role:${TEAM_GUILD_ID}:${LEADER_ID}`;
const ATTACHED_ROLE_ID = 'integration-team-role';
const BOOTSTRAP_CLAIM = 'whitelist:env-bootstrap:v1';
const REDIS_IDEMPOTENCY_KEY = 'bublik:integration:ci:idempotency';

async function cleanup(): Promise<void> {
  const db = getDatabase();
  await db.operationClaim.deleteMany({
    where: {
      OR: [
        { key: BOOTSTRAP_CLAIM },
        { guildId: { in: [TEST_GUILD_ID, TEAM_GUILD_ID, WELCOME_GUILD_ID] } },
      ],
    },
  });
  await db.allowedGuild.deleteMany({ where: { guildId: TEST_GUILD_ID } });
  await db.teamConfig.deleteMany({ where: { guildId: TEAM_GUILD_ID } });
}

async function verifyWelcomeRoleGrantCas(): Promise<void> {
  const db = getDatabase();
  const input = {
    guildId: WELCOME_GUILD_ID,
    userId: WELCOME_USER_ID,
    roleId: 'integration-welcome-role',
    kind: 'auto' as const,
    policy: 'join' as const,
    membershipGeneration: 'integration-membership-generation',
  };

  const prepared = await prepareWelcomeRoleGrantIntent(
    input,
    db,
    1_000,
    'integration-welcome-token',
  );
  assert.equal(prepared.created, true);
  assert.equal(prepared.intent.revision, 0);

  const dispatched = await recordWelcomeRoleGrantDispatch(prepared.intent, db, 2_000);
  assert.equal(dispatched.revision, 1);
  assert.equal(dispatched.dispatchAttempts, 1);

  await assert.rejects(
    recordWelcomeRoleGrantDispatch(prepared.intent, db, 3_000),
    (error: unknown) => error instanceof WelcomeRoleGrantIntentFencedError,
    'a stale same-token revision must not overwrite a newer dispatch',
  );
  await assert.rejects(
    completeWelcomeRoleGrantIntent(prepared.intent, db),
    (error: unknown) => error instanceof WelcomeRoleGrantIntentFencedError,
    'a stale same-token revision must not delete a newer dispatch',
  );
  await assert.rejects(
    replaceWelcomeRoleGrantIntent(
      prepared.intent,
      { ...input, membershipGeneration: 'stale-replacement-generation' },
      db,
      4_000,
      'stale-replacement-token',
    ),
    (error: unknown) => error instanceof WelcomeRoleGrantIntentFencedError,
    'a stale same-token revision must not replace a newer dispatch',
  );

  const persisted = await readWelcomeRoleGrantIntent(
    WELCOME_GUILD_ID,
    WELCOME_USER_ID,
    'auto',
    db,
  );
  assert.deepEqual(persisted, dispatched);
  assert.equal(await completeWelcomeRoleGrantIntent(dispatched, db), true);
  assert.equal(
    await readWelcomeRoleGrantIntent(WELCOME_GUILD_ID, WELCOME_USER_ID, 'auto', db),
    null,
  );
}

async function verifyWhitelistBootstrap(): Promise<void> {
  assert.ok(
    Config.allowedGuilds.includes(TEST_GUILD_ID),
    `ALLOWED_GUILDS must contain ${TEST_GUILD_ID} for the integration smoke test`,
  );

  await initWhitelist(true);
  assert.equal(isGuildAllowed(TEST_GUILD_ID), true);
  assert.deepEqual(getAllowedGuildsList(), [TEST_GUILD_ID]);

  assert.equal(await removeAllowedGuild(TEST_GUILD_ID), true);
  assert.equal(isGuildAllowed(TEST_GUILD_ID), false);

  // A forced reload simulates the next process startup. The durable bootstrap
  // claim must prevent ALLOWED_GUILDS from resurrecting a deliberately removed
  // final guild.
  await initWhitelist(true);
  assert.equal(isGuildAllowed(TEST_GUILD_ID), false);
  assert.equal(await getDatabase().allowedGuild.count({ where: { guildId: TEST_GUILD_ID } }), 0);
  assert.equal(await getDatabase().operationClaim.count({ where: { key: BOOTSTRAP_CLAIM } }), 1);
}

async function cleanupRedisFixture(): Promise<void> {
  await getRedis().del(REDIS_IDEMPOTENCY_KEY);
}

async function verifyRedisRoundTrip(): Promise<void> {
  const redis = getRedis();
  assert.equal(await redis.ping(), 'PONG');

  const policy = await redis.config('GET', 'maxmemory-policy');
  assert.ok(Array.isArray(policy), 'Redis CONFIG GET must return a key/value array');
  assert.equal(policy[0], 'maxmemory-policy');
  assert.equal(policy[1], 'noeviction', 'CI Redis must use the production noeviction policy');

  await cleanupRedisFixture();
  assert.equal(
    await redis.set(REDIS_IDEMPOTENCY_KEY, 'owner-a', 'EX', 60, 'NX'),
    'OK',
  );
  assert.equal(
    await redis.set(REDIS_IDEMPOTENCY_KEY, 'owner-b', 'EX', 60, 'NX'),
    null,
    'a second owner must not acquire the same idempotency key',
  );
  assert.equal(await redis.get(REDIS_IDEMPOTENCY_KEY), 'owner-a');
  assert.equal(await redis.del(REDIS_IDEMPOTENCY_KEY), 1);
  assert.equal(await redis.get(REDIS_IDEMPOTENCY_KEY), null);
}

async function verifyTeamSagas(): Promise<void> {
  const db = getDatabase();
  const config = await db.teamConfig.create({ data: { guildId: TEAM_GUILD_ID } });
  const { team, application } = await createPendingTeamWithLeaderApplication({
    guildId: TEAM_GUILD_ID,
    name: 'Integration Team',
    pendingRoleId: PENDING_ROLE_ID,
    leaderId: LEADER_ID,
    configId: config.id,
    applicationChannelId: 'integration-application-channel',
  });

  assert.equal(team.members.length, 1);
  assert.equal(team.members[0].guildId, TEAM_GUILD_ID);
  assert.equal(application.activeKey, team.id);
  assert.equal(await attachCreatedTeamRole(team.id, PENDING_ROLE_ID, ATTACHED_ROLE_ID), true);
  assert.equal(await attachCreatedTeamRole(team.id, PENDING_ROLE_ID, 'wrong-second-role'), false);

  await db.teamMember.create({
    data: { teamId: team.id, guildId: TEAM_GUILD_ID, userId: MEMBER_ID },
  });
  const claim = await claimMemberKick(team.id, MEMBER_ID, TEAM_GUILD_ID, LEADER_ID);
  assert.ok(claim);
  assert.equal(claim.roleId, ATTACHED_ROLE_ID);
  assert.equal(
    await db.teamMember.count({ where: { teamId: team.id, guildId: TEAM_GUILD_ID, userId: MEMBER_ID } }),
    1,
    'membership must survive until the Discord role mutation is confirmed',
  );
  assert.equal(await claimMemberKick(team.id, MEMBER_ID, TEAM_GUILD_ID, LEADER_ID), null);

  assert.equal(await finalizeClaimedMemberKick(claim), true);
  assert.equal(
    await db.teamMember.count({ where: { teamId: team.id, guildId: TEAM_GUILD_ID, userId: MEMBER_ID } }),
    0,
  );
  assert.equal(await db.operationClaim.count({ where: { key: claim.key } }), 0);
  assert.equal(await finalizeClaimedMemberKick(claim), false);
}

async function main(): Promise<void> {
  if (process.env.RUN_DB_INTEGRATION !== '1' || Config.nodeEnv !== 'test') {
    throw new Error('Refusing to run DB integration smoke test without RUN_DB_INTEGRATION=1 and NODE_ENV=test');
  }

  let databaseConnected = false;
  let redisConnected = false;
  let primaryError: unknown = null;
  try {
    await connectDatabase();
    databaseConnected = true;
    await connectRedis();
    redisConnected = true;
    await cleanup();
    await cleanupRedisFixture();

    await verifyRedisRoundTrip();
    await verifyWhitelistBootstrap();
    await verifyTeamSagas();
    await verifyWelcomeRoleGrantCas();
    process.stdout.write('database + Redis integration smoke test passed\n');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (redisConnected) {
      try { await cleanupRedisFixture(); } catch (error) { cleanupErrors.push(error); }
      try { await disconnectRedis(); } catch (error) { cleanupErrors.push(error); }
    }
    if (databaseConnected) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
      try { await disconnectDatabase(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, 'integration cleanup failed');
      if (!primaryError) throw cleanupError;
      console.error(cleanupError);
    }
  }
}

void main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectRedis().catch(() => undefined);
  await disconnectDatabase().catch(() => undefined);
  process.exitCode = 1;
});
