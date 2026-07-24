import test from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType, PermissionsBitField } from 'discord.js';
import {
  areTeamPermissionOverwritesEquivalent,
  buildPrivateTeamSquadOverwrites,
  getVoiceInviteMemberCleanupAction,
  persistVoiceInviteIntentIfOwned,
  shouldCleanupVoiceInviteIntent,
  runVoiceInviteMutationWithImmediateRepair,
  VOICE_INVITE_CLEAR_PERMISSIONS,
  withVoiceInviteScopeLease,
  type VoiceInviteAtomicStore,
  type VoiceInviteClearWrite,
  type VoiceInviteIntentWrite,
  type VoiceInviteOccupancyClearWrite,
  type VoiceInviteOccupancyWrite,
  type VoiceInviteLeaseStore,
} from '../../src/modules/teams/voiceIntegration';

const VIEW = PermissionsBitField.Flags.ViewChannel;
const CONNECT = PermissionsBitField.Flags.Connect;

class MemoryVoiceInviteLeaseStore implements VoiceInviteLeaseStore {
  private readonly owners = new Map<string, string>();

  async acquire(key: string, token: string): Promise<boolean> {
    if (this.owners.has(key)) return false;
    this.owners.set(key, token);
    return true;
  }

  async readToken(key: string): Promise<string | null> {
    return this.owners.get(key) ?? null;
  }

  async renew(key: string, token: string): Promise<boolean> {
    return this.owners.get(key) === token;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.owners.get(key) === token) this.owners.delete(key);
  }

  expire(key: string): void {
    this.owners.delete(key);
  }
}

class MemoryVoiceInviteAtomicStore implements VoiceInviteAtomicStore {
  raw: string | null = null;
  occupancyToken: string | null = null;
  private blockedToken: string | null = null;
  private blockedStarted: (() => void) | null = null;
  private blockedGate: Promise<void> | null = null;
  private clearStarted: (() => void) | null = null;
  private clearGate: Promise<void> | null = null;

  constructor(private readonly leases: VoiceInviteLeaseStore) {}

  blockToken(token: string, started: () => void, gate: Promise<void>): void {
    this.blockedToken = token;
    this.blockedStarted = started;
    this.blockedGate = gate;
  }

  blockClear(started: () => void, gate: Promise<void>): void {
    this.clearStarted = started;
    this.clearGate = gate;
  }

  private async owns(
    ownership: VoiceInviteIntentWrite['ownership'],
  ): Promise<boolean> {
    const [scope, invite] = ownership;
    return await this.leases.readToken(scope.key) === scope.token &&
      await this.leases.readToken(invite.key) === invite.token;
  }

  async persistIntentIfOwned(input: VoiceInviteIntentWrite): Promise<boolean> {
    const parsed = JSON.parse(input.raw) as { token?: string };
    if (parsed.token === this.blockedToken && this.blockedGate) {
      this.blockedStarted?.();
      await this.blockedGate;
    }
    if (!await this.owns(input.ownership)) return false;
    this.raw = input.raw;
    return true;
  }

  async persistOccupancyIfOwned(_input: VoiceInviteOccupancyWrite): Promise<boolean> {
    return false;
  }

  async clearIntentIfOwned(input: VoiceInviteClearWrite): Promise<boolean> {
    if (this.clearGate) {
      this.clearStarted?.();
      await this.clearGate;
    }
    if (!await this.owns(input.ownership) || this.raw !== input.expectedIntentRaw) return false;
    this.raw = null;
    this.occupancyToken = null;
    return true;
  }

  async clearOccupancyIfOwned(input: VoiceInviteOccupancyClearWrite): Promise<boolean> {
    if (!await this.owns(input.ownership) ||
        this.occupancyToken !== input.expectedOccupancyToken) return false;
    this.occupancyToken = null;
    return true;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const fastLease = {
  ttlMs: 1_000,
  renewMs: 500,
  waitTimeoutMs: 500,
  retryDelayMs: 1,
};

test('private team squad denies generic access and allows only exact principals', () => {
  const result = buildPrivateTeamSquadOverwrites([
    {
      id: 'guild',
      type: OverwriteType.Role,
      allow: VIEW | CONNECT | PermissionsBitField.Flags.SendMessages,
      deny: 0n,
    },
    {
      id: 'generic-role',
      type: OverwriteType.Role,
      allow: VIEW | CONNECT | PermissionsBitField.Flags.Speak,
      deny: 0n,
    },
    {
      id: 'team-role',
      type: OverwriteType.Role,
      allow: PermissionsBitField.Flags.Stream,
      deny: VIEW | CONNECT,
    },
    {
      id: 'random-user',
      type: OverwriteType.Member,
      allow: VIEW | PermissionsBitField.Flags.SendMessages,
      deny: 0n,
    },
  ], 'guild', 'owner', 'team-role', 'bot', new Set(['guest']));

  const byKey = new Map(result.map((overwrite) => {
    const value = overwrite as { id: string; type: OverwriteType; allow?: bigint; deny?: bigint };
    return [`${value.type}:${value.id}`, value] as const;
  }));
  const permissions = (type: OverwriteType, id: string) => {
    const value = byKey.get(`${type}:${id}`);
    assert.ok(value, `missing overwrite ${type}:${id}`);
    return {
      allow: new PermissionsBitField(value.allow ?? 0n),
      deny: new PermissionsBitField(value.deny ?? 0n),
    };
  };

  for (const [type, id] of [
    [OverwriteType.Role, 'guild'],
    [OverwriteType.Role, 'generic-role'],
  ] as const) {
    const value = permissions(type, id);
    assert.equal(value.allow.has(VIEW), false);
    assert.equal(value.allow.has(CONNECT), false);
    assert.equal(value.deny.has(VIEW), true);
    assert.equal(value.deny.has(CONNECT), true);
  }

  const unrelatedMember = permissions(OverwriteType.Member, 'random-user');
  assert.equal(unrelatedMember.allow.has(VIEW), false);
  assert.equal(unrelatedMember.allow.has(CONNECT), false);
  assert.equal(unrelatedMember.deny.has(VIEW), false);
  assert.equal(unrelatedMember.deny.has(CONNECT), false);

  for (const [type, id] of [
    [OverwriteType.Role, 'team-role'],
    [OverwriteType.Member, 'owner'],
    [OverwriteType.Member, 'bot'],
    [OverwriteType.Member, 'guest'],
  ] as const) {
    const value = permissions(type, id);
    assert.equal(value.allow.has(VIEW), true);
    assert.equal(value.allow.has(CONNECT), true);
    assert.equal(value.deny.has(VIEW), false);
    assert.equal(value.deny.has(CONNECT), false);
  }

  assert.equal(permissions(OverwriteType.Role, 'guild').allow.has(PermissionsBitField.Flags.SendMessages), true);
  assert.equal(permissions(OverwriteType.Role, 'generic-role').allow.has(PermissionsBitField.Flags.Speak), true);
  assert.equal(permissions(OverwriteType.Role, 'team-role').allow.has(PermissionsBitField.Flags.Stream), true);
  assert.equal(byKey.size, result.length);
});

test('private team squad creates missing everyone deny and rejects everyone as team role', () => {
  const result = buildPrivateTeamSquadOverwrites([
    {
      id: 'member-with-old-deny',
      type: OverwriteType.Member,
      allow: 0n,
      deny: VIEW | CONNECT | PermissionsBitField.Flags.SendMessages,
    },
  ], 'guild', 'owner', 'team-role', 'bot', new Set());
  const values = result.map((overwrite) =>
    overwrite as { id: string; type: OverwriteType; allow?: bigint; deny?: bigint });
  const everyone = values.find((value) => value.type === OverwriteType.Role && value.id === 'guild');
  assert.ok(everyone);
  assert.equal(new PermissionsBitField(everyone.deny ?? 0n).has(VIEW), true);
  assert.equal(new PermissionsBitField(everyone.deny ?? 0n).has(CONNECT), true);

  const unrelated = values.find((value) => value.type === OverwriteType.Member && value.id === 'member-with-old-deny');
  assert.ok(unrelated);
  const unrelatedDeny = new PermissionsBitField(unrelated.deny ?? 0n);
  assert.equal(unrelatedDeny.has(VIEW), false);
  assert.equal(unrelatedDeny.has(CONNECT), false);
  assert.equal(unrelatedDeny.has(PermissionsBitField.Flags.SendMessages), true);

  assert.throws(() => buildPrivateTeamSquadOverwrites(
    [], 'guild', 'owner', 'guild', 'bot', new Set(),
  ), /@everyone/);
});

test('private squad canonicalizer drops empty unrelated member overwrites', () => {
  const result = buildPrivateTeamSquadOverwrites([
    {
      id: 'already-empty',
      type: OverwriteType.Member,
      allow: 0n,
      deny: 0n,
    },
    {
      id: 'temporary-only',
      type: OverwriteType.Member,
      allow: VIEW,
      deny: CONNECT,
    },
    {
      id: 'other-bits',
      type: OverwriteType.Member,
      allow: VIEW | PermissionsBitField.Flags.Speak,
      deny: CONNECT | PermissionsBitField.Flags.Stream,
    },
  ], 'guild', 'owner', 'team-role', 'bot', new Set());
  const byKey = new Map(result.map((overwrite) => [`${overwrite.type}:${overwrite.id}`, overwrite]));

  assert.equal(byKey.has(`${OverwriteType.Member}:already-empty`), false);
  assert.equal(byKey.has(`${OverwriteType.Member}:temporary-only`), false);
  const preserved = byKey.get(`${OverwriteType.Member}:other-bits`);
  assert.ok(preserved);
  assert.equal(preserved.allow, PermissionsBitField.Flags.Speak);
  assert.equal(preserved.deny, PermissionsBitField.Flags.Stream);
});

test('private squad reconciliation skips only an exactly equivalent overwrite set', () => {
  const current = [
    { id: 'guild', type: OverwriteType.Role, allow: 0n, deny: VIEW | CONNECT },
    { id: 'owner', type: OverwriteType.Member, allow: VIEW | CONNECT, deny: 0n },
  ];
  assert.equal(areTeamPermissionOverwritesEquivalent(current, [...current].reverse()), true);
  assert.equal(areTeamPermissionOverwritesEquivalent(current, [
    current[0],
    { ...current[1], allow: VIEW },
  ]), false);
  assert.equal(areTeamPermissionOverwritesEquivalent(current, [current[0]]), false);
});

test('voice invite cleanup clears only temporary access bits', () => {
  assert.deepEqual(VOICE_INVITE_CLEAR_PERMISSIONS, {
    Connect: null,
    ViewChannel: null,
  });
});

test('voice invite cleanup deletes only a member overwrite with no remaining permissions', () => {
  assert.equal(getVoiceInviteMemberCleanupAction(null), 'none');
  assert.equal(getVoiceInviteMemberCleanupAction({
    id: 'role',
    type: OverwriteType.Role,
    allow: VIEW | CONNECT,
    deny: 0n,
  }), 'none');
  assert.equal(getVoiceInviteMemberCleanupAction({
    id: 'temporary-only',
    type: OverwriteType.Member,
    allow: VIEW,
    deny: CONNECT,
  }), 'delete');
  assert.equal(getVoiceInviteMemberCleanupAction({
    id: 'already-empty',
    type: OverwriteType.Member,
    allow: 0n,
    deny: 0n,
  }), 'delete');
  assert.equal(getVoiceInviteMemberCleanupAction({
    id: 'other-bits',
    type: OverwriteType.Member,
    allow: VIEW | PermissionsBitField.Flags.Speak,
    deny: CONNECT,
  }), 'edit');
});

test('a stale voice leave cannot clean a newer invite generation', () => {
  const oldIntent = JSON.stringify({ version: 2, token: 'old', expiresAt: Date.now() + 60_000 });
  const newIntent = JSON.stringify({ version: 2, token: 'new', expiresAt: Date.now() + 60_000 });
  assert.equal(shouldCleanupVoiceInviteIntent(oldIntent, 'old'), true);
  assert.equal(shouldCleanupVoiceInviteIntent(newIntent, 'old'), false);
  assert.equal(shouldCleanupVoiceInviteIntent(newIntent, null), false);
  assert.equal(shouldCleanupVoiceInviteIntent('1', null), true);
  assert.equal(shouldCleanupVoiceInviteIntent('corrupt', 'old'), false);
});

test('privacy reconcile cannot resurrect an invite after concurrent cleanup', async () => {
  const store = new MemoryVoiceInviteLeaseStore();
  const snapshotRead = deferred();
  const permitCanonicalWrite = deferred();
  let intentActive = true;
  let overwriteAllowsAccess = true;
  let cleanupEntered = false;

  const reconcile = withVoiceInviteScopeLease(store, 'squad', async (assertOwned) => {
    const snapshot = intentActive;
    snapshotRead.resolve();
    await permitCanonicalWrite.promise;
    await assertOwned();
    overwriteAllowsAccess = snapshot;
  }, fastLease);
  await snapshotRead.promise;

  const cleanup = withVoiceInviteScopeLease(store, 'squad', async () => {
    cleanupEntered = true;
    intentActive = false;
    overwriteAllowsAccess = false;
  }, fastLease);
  await Promise.resolve();
  assert.equal(cleanupEntered, false);

  permitCanonicalWrite.resolve();
  await Promise.all([reconcile, cleanup]);
  assert.equal(intentActive, false);
  assert.equal(overwriteAllowsAccess, false);
});

test('privacy reconcile cannot erase a concurrently-created invite', async () => {
  const store = new MemoryVoiceInviteLeaseStore();
  const snapshotRead = deferred();
  const permitCanonicalWrite = deferred();
  let intentActive = false;
  let overwriteAllowsAccess = false;
  let inviteEntered = false;

  const reconcile = withVoiceInviteScopeLease(store, 'squad', async (assertOwned) => {
    const snapshot = intentActive;
    snapshotRead.resolve();
    await permitCanonicalWrite.promise;
    await assertOwned();
    overwriteAllowsAccess = snapshot;
  }, fastLease);
  await snapshotRead.promise;

  const invite = withVoiceInviteScopeLease(store, 'squad', async () => {
    inviteEntered = true;
    intentActive = true;
    overwriteAllowsAccess = true;
  }, fastLease);
  await Promise.resolve();
  assert.equal(inviteEntered, false);

  permitCanonicalWrite.resolve();
  await Promise.all([reconcile, invite]);
  assert.equal(intentActive, true);
  assert.equal(overwriteAllowsAccess, true);
});

test('lost cleanup lease immediately repairs a newer invite after stale Discord delete', async () => {
  const store = new MemoryVoiceInviteLeaseStore();
  const scopeKey = 'tm:vinvite:scope-lock:squad';
  let currentIntentActive = false;
  let overwriteAllowsAccess = true;
  let repairs = 0;

  await runVoiceInviteMutationWithImmediateRepair(
    (markDiscordMutation) => withVoiceInviteScopeLease(store, 'squad', async (assertOwned) => {
      await assertOwned();
      markDiscordMutation();

      // The old lease expires while its Discord DELETE is in flight. A fresh
      // invite acquires the scope and grants access before that stale DELETE
      // lands out of order.
      store.expire(scopeKey);
      await withVoiceInviteScopeLease(store, 'squad', async (assertNewInviteOwned) => {
        currentIntentActive = true;
        overwriteAllowsAccess = true;
        await assertNewInviteOwned();
      }, fastLease);
      overwriteAllowsAccess = false;
      await assertOwned();
    }, fastLease),
    () => withVoiceInviteScopeLease(store, 'squad', async (assertRepairOwned) => {
      repairs++;
      await assertRepairOwned();
      overwriteAllowsAccess = currentIntentActive;
      await assertRepairOwned();
    }, fastLease),
  );

  assert.equal(repairs, 1);
  assert.equal(currentIntentActive, true);
  assert.equal(overwriteAllowsAccess, true);
});

test('stale voice invite writer cannot overwrite a newer fenced generation', async () => {
  const leases = new MemoryVoiceInviteLeaseStore();
  const atomic = new MemoryVoiceInviteAtomicStore(leases);
  const oldStarted = deferred();
  const releaseOld = deferred();
  atomic.blockToken('old', oldStarted.resolve, releaseOld.promise);

  const persist = (
    token: string,
    ownership: VoiceInviteIntentWrite['ownership'],
  ) => persistVoiceInviteIntentIfOwned(atomic, {
    ownership,
    intentKey: 'intent',
    expiryIndexKey: 'expiries',
    expiryMember: 'squad:user',
    ttlMs: 60_000,
    raw: JSON.stringify({ version: 2, token, expiresAt: Date.now() + 60_000 }),
    expiresAt: Date.now() + 60_000,
  });

  const old = withVoiceInviteScopeLease(leases, 'squad', async (_assertScope, scope) =>
    withVoiceInviteScopeLease(leases, 'squad-user', async (_assertInvite, invite) =>
      persist('old', [scope, invite]), fastLease), fastLease);
  await oldStarted.promise;

  leases.expire('tm:vinvite:scope-lock:squad');
  leases.expire('tm:vinvite:scope-lock:squad-user');
  await withVoiceInviteScopeLease(leases, 'squad', async (_assertScope, scope) =>
    withVoiceInviteScopeLease(leases, 'squad-user', async (_assertInvite, invite) =>
      persist('new', [scope, invite]), fastLease), fastLease);

  releaseOld.resolve();
  await assert.rejects(old, /lease was lost/);
  assert.equal((JSON.parse(atomic.raw ?? '{}') as { token?: string }).token, 'new');
});

test('stale leave cannot clear a same-token rejoin after both leases changed', async () => {
  const leases = new MemoryVoiceInviteLeaseStore();
  const atomic = new MemoryVoiceInviteAtomicStore(leases);
  const clearStarted = deferred();
  const releaseClear = deferred();
  const raw = JSON.stringify({ version: 2, token: 'same', expiresAt: Date.now() + 60_000 });
  atomic.raw = raw;
  atomic.occupancyToken = 'same';
  atomic.blockClear(clearStarted.resolve, releaseClear.promise);

  const oldClear = withVoiceInviteScopeLease(leases, 'squad', async (_assertScope, scope) =>
    withVoiceInviteScopeLease(leases, 'squad-user', async (_assertInvite, invite) =>
      atomic.clearIntentIfOwned({
        ownership: [scope, invite],
        intentKey: 'intent',
        expectedIntentRaw: raw,
        occupancyKey: 'occupancy',
        expiryIndexKey: 'expiries',
        expiryMember: 'squad:user',
      }), fastLease), fastLease);
  await clearStarted.promise;

  leases.expire('tm:vinvite:scope-lock:squad');
  leases.expire('tm:vinvite:scope-lock:squad-user');
  await withVoiceInviteScopeLease(leases, 'squad', async (assertScope) =>
    withVoiceInviteScopeLease(leases, 'squad-user', async (assertInvite) => {
      await assertScope();
      await assertInvite();
      // Rejoin of the same durable invite legitimately reuses its token/raw.
      atomic.raw = raw;
      atomic.occupancyToken = 'same';
    }, fastLease), fastLease);

  releaseClear.resolve();
  assert.equal(await oldClear, false);
  assert.equal(atomic.raw, raw);
  assert.equal(atomic.occupancyToken, 'same');
});

test('lost whole-channel reconcile lease immediately reapplies the current invite snapshot', async () => {
  const store = new MemoryVoiceInviteLeaseStore();
  const scopeKey = 'tm:vinvite:scope-lock:squad';
  let currentIntentActive = false;
  let overwriteAllowsAccess = false;
  let repairs = 0;

  await runVoiceInviteMutationWithImmediateRepair(
    (markDiscordMutation) => withVoiceInviteScopeLease(store, 'squad', async (assertOwned) => {
      const staleSnapshot = currentIntentActive;
      await assertOwned();
      markDiscordMutation();
      store.expire(scopeKey);
      await withVoiceInviteScopeLease(store, 'squad', async (assertNewOwned) => {
        currentIntentActive = true;
        overwriteAllowsAccess = true;
        await assertNewOwned();
      }, fastLease);
      overwriteAllowsAccess = staleSnapshot;
      await assertOwned();
    }, fastLease),
    () => withVoiceInviteScopeLease(store, 'squad', async (assertRepairOwned) => {
      repairs++;
      await assertRepairOwned();
      overwriteAllowsAccess = currentIntentActive;
      await assertRepairOwned();
    }, fastLease),
  );

  assert.equal(repairs, 1);
  assert.equal(overwriteAllowsAccess, true);
});

test('revoked invite after ambiguous move is compensated and reports inactive', async () => {
  const store = new MemoryVoiceInviteLeaseStore();
  const scopeKey = 'tm:vinvite:scope-lock:squad';
  let currentIntentActive = true;
  let memberInTarget = false;

  const activeAfterRepair = await runVoiceInviteMutationWithImmediateRepair(
    (markDiscordMutation) => withVoiceInviteScopeLease(store, 'squad', async (assertOwned) => {
      await assertOwned();
      markDiscordMutation();
      store.expire(scopeKey);
      await withVoiceInviteScopeLease(store, 'squad', async (assertCleanupOwned) => {
        currentIntentActive = false;
        await assertCleanupOwned();
      }, fastLease);
      // The old Discord MOVE lands after revocation.
      memberInTarget = true;
      await assertOwned();
      return true;
    }, fastLease),
    () => withVoiceInviteScopeLease(store, 'squad', async (assertRepairOwned) => {
      await assertRepairOwned();
      if (!currentIntentActive) memberInTarget = false;
      await assertRepairOwned();
      return currentIntentActive;
    }, fastLease),
  );

  assert.equal(activeAfterRepair, false);
  assert.equal(memberInTarget, false);
});
