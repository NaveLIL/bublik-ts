import test from 'node:test';
import assert from 'node:assert/strict';
import { NsType, VacationStatus } from '../src/modules/vacation/constants';
import {
  buildVacationRoleSnapshot,
  buildVacationSuppressedRoleIds,
  canReviewVacation,
  hasExactPbPingRoleProvenance,
  isNsInformationalVacation,
  isNsTransitionAllowed,
  isVacationTerminalStatus,
  isVacationTransitionAllowed,
  normalizeVacationSavedRoleIds,
  nsVacationActiveKey,
  planVacationRoleIntegrity,
  runVacationActivationRolePhases,
  runVacationRestoreRolePhases,
  selectSavedRoles,
  selectVacationSavedRoles,
  vacationRoleConfigurationIsDistinct,
  vacationRoleChangeRequested,
  vacationActiveKey,
} from '../src/modules/vacation/state';
import { fetchGuildIfPresent } from '../src/utils/helpers';

test('one regular vacation slot covers pending through restoring', () => {
  assert.equal(vacationActiveKey('g', 'u'), 'g:u');
  assert.equal(isVacationTerminalStatus(VacationStatus.Pending), false);
  assert.equal(isVacationTerminalStatus(VacationStatus.Restoring), false);
  assert.equal(isVacationTerminalStatus(VacationStatus.Completed), true);
});

test('vacation state machine rejects shortcuts that would lose role restoration', () => {
  assert.equal(isVacationTransitionAllowed(VacationStatus.Pending, VacationStatus.Activating), true);
  assert.equal(isVacationTransitionAllowed(VacationStatus.Active, VacationStatus.Completed), false);
  assert.equal(isVacationTransitionAllowed(VacationStatus.Restoring, VacationStatus.Completed), true);
  assert.equal(isVacationTransitionAllowed(VacationStatus.Completed, VacationStatus.Active), false);
});

test('NS role-changing actions share a slot and use guarded restore transitions', () => {
  assert.equal(
    nsVacationActiveKey('g', 'u', NsType.Shield),
    nsVacationActiveKey('g', 'u', NsType.Troll),
  );
  assert.notEqual(
    nsVacationActiveKey('g', 'u', NsType.Shield),
    nsVacationActiveKey('g', 'u', NsType.Vacation),
  );
  assert.equal(isNsTransitionAllowed('active', 'completed'), true);
  assert.equal(isNsTransitionAllowed('completed', 'active'), false);
});

test('informational NS vacation has a durable activation phase without role mutation semantics', () => {
  assert.equal(isNsInformationalVacation(NsType.Vacation), true);
  assert.equal(isNsInformationalVacation(NsType.Shield), false);
  assert.equal(isNsInformationalVacation(NsType.Troll), false);
  assert.equal(isNsTransitionAllowed('activating', 'active'), true);
  assert.equal(isNsTransitionAllowed('activating', 'completed'), true);
});

test('empty reviewer configuration is fail-closed except explicit ManageGuild', () => {
  assert.equal(canReviewVacation([], new Set(), false), false);
  assert.equal(canReviewVacation([], new Set(), true), true);
  assert.equal(canReviewVacation(['reviewer'], new Set(['other']), false), false);
  assert.equal(canReviewVacation(['reviewer'], new Set(['reviewer']), false), true);
});

test('role snapshot is deterministic, filtered and deduplicated', () => {
  assert.deepEqual(
    selectSavedRoles(['everyone', 'a', 'a', 'b'], new Set(['a', 'b']), new Set(['b'])),
    ['a'],
  );
});

test('new regular vacation snapshots the current PB ping role automatically', () => {
  assert.deepEqual(
    selectVacationSavedRoles(
      ['everyone', 'configured', 'pb-ping'],
      ['configured'],
      'pb-ping',
    ),
    ['configured', 'pb-ping'],
  );
  assert.deepEqual(
    selectVacationSavedRoles(['configured'], ['configured'], 'pb-ping'),
    ['configured'],
  );
});

test('vacation and PB ping roles are mutually exclusive with database state as authority', () => {
  assert.deepEqual(planVacationRoleIntegrity(true, true, true), {
    removePingRole: true,
    removeVacationRole: false,
    ensureVacationRole: false,
  });
  assert.deepEqual(planVacationRoleIntegrity(true, true, false), {
    removePingRole: true,
    removeVacationRole: false,
    ensureVacationRole: true,
  });
  assert.deepEqual(planVacationRoleIntegrity(false, true, true), {
    removePingRole: false,
    removeVacationRole: true,
    ensureVacationRole: false,
  });
  assert.deepEqual(planVacationRoleIntegrity(false, true, false), {
    removePingRole: false,
    removeVacationRole: false,
    ensureVacationRole: false,
  });
});

test('vacation role configuration rejects PB and remove-list collisions', () => {
  assert.equal(vacationRoleConfigurationIsDistinct('vacation', ['ping'], ['other']), true);
  assert.equal(vacationRoleConfigurationIsDistinct('vacation', ['vacation'], []), false);
  assert.equal(vacationRoleConfigurationIsDistinct('vacation', ['ping', 'vacation'], []), false);
  assert.equal(vacationRoleConfigurationIsDistinct('vacation', ['ping', null, 'vacation'], []), false);
  assert.equal(vacationRoleConfigurationIsDistinct('vacation', [null], ['vacation']), false);
  assert.equal(vacationRoleConfigurationIsDistinct(null, ['ping'], ['other']), true);
});

test('vacation role changes require the serialized holder scan only for an established role', () => {
  assert.equal(vacationRoleChangeRequested('old', 'new'), true);
  assert.equal(vacationRoleChangeRequested('same', 'same'), false);
  assert.equal(vacationRoleChangeRequested(null, 'initial'), false);
  assert.equal(vacationRoleChangeRequested('old', null), false);
});

test('legacy saved-role snapshots never restore the vacation marker', () => {
  assert.deepEqual(
    normalizeVacationSavedRoleIds(['ping', 'vacation', 'rank', 'vacation'], 'vacation'),
    ['ping', 'rank'],
  );
  assert.deepEqual(normalizeVacationSavedRoleIds(['ping'], null), ['ping']);
});

test('activation snapshot restores only an actually held or durably proven ping role', () => {
  assert.deepEqual(buildVacationRoleSnapshot({
    currentRoleIds: ['rank', 'ping', 'vacation'],
    configuredRemoveRoleIds: ['rank', 'vacation'],
    pingRoleId: 'ping',
    vacationRoleId: 'vacation',
    hasProvenPbPingProvenance: false,
  }), ['rank', 'ping']);
  assert.deepEqual(buildVacationRoleSnapshot({
    currentRoleIds: ['rank'],
    configuredRemoveRoleIds: ['rank'],
    pingRoleId: 'ping',
    vacationRoleId: 'vacation',
    hasProvenPbPingProvenance: false,
  }), ['rank']);
  assert.deepEqual(buildVacationRoleSnapshot({
    currentRoleIds: ['rank'],
    configuredRemoveRoleIds: ['rank'],
    pingRoleId: 'ping',
    vacationRoleId: 'vacation',
    hasProvenPbPingProvenance: true,
  }), ['rank', 'ping']);
});

test('PB provenance proves only the exact currently configured ping role', () => {
  const direct = {
    version: 2,
    hadPingRole: true,
    pingRoleId: 'old-ping',
    returnRoleIds: ['old-ping'],
    playedResetRoleIds: [] as string[],
  };
  assert.equal(hasExactPbPingRoleProvenance(direct, 'old-ping'), true);
  assert.equal(hasExactPbPingRoleProvenance(direct, 'new-ping'), false);
  assert.equal(hasExactPbPingRoleProvenance({
    ...direct,
    returnRoleIds: [],
  }, 'old-ping'), false);
  assert.equal(hasExactPbPingRoleProvenance({
    ...direct,
    hadPingRole: false,
    pingRoleId: 'old-ping',
    returnRoleIds: [],
    playedResetRoleIds: ['new-ping'],
  }, 'new-ping'), true);
});

test('active reconciliation suppresses a newly granted ping without learning it for restore', () => {
  const sealed = ['rank'];
  assert.deepEqual(buildVacationSuppressedRoleIds(
    sealed,
    ['rank', 'ping', 'new-managed', 'vacation'],
    ['rank', 'new-managed'],
    'ping',
    'vacation',
  ), ['rank', 'new-managed', 'ping']);
  assert.deepEqual(sealed, ['rank']);
});

test('activation never adds the vacation marker after a suppression failure', async () => {
  const events: string[] = [];
  await assert.rejects(
    () => runVacationActivationRolePhases(
      async () => {
        events.push('suppress');
        throw new Error('remove failed');
      },
      async () => { events.push('marker'); },
    ),
    /remove failed/,
  );
  assert.deepEqual(events, ['suppress']);
});

test('restore never grants saved roles after vacation marker removal fails', async () => {
  const events: string[] = [];
  await assert.rejects(
    () => runVacationRestoreRolePhases(
      async () => { events.push('suppress'); },
      async () => {
        events.push('marker');
        throw new Error('remove marker failed');
      },
      async () => { events.push('restore'); },
    ),
    /remove marker failed/,
  );
  assert.deepEqual(events, ['suppress', 'marker']);
});

test('restore suppresses unproven roles before removing the marker and granting saved roles', async () => {
  const events: string[] = [];
  await runVacationRestoreRolePhases(
    async () => { events.push('suppress'); },
    async () => { events.push('marker'); },
    async () => { events.push('restore'); },
  );
  assert.deepEqual(events, ['suppress', 'marker', 'restore']);
});

test('transient guild lookup cannot complete an activating vacation', async () => {
  await assert.rejects(
    () => fetchGuildIfPresent(async () => {
      throw new Error('Discord gateway timeout');
    }),
    /gateway timeout/,
  );
  assert.equal(
    await fetchGuildIfPresent(async () => {
      throw { code: 10_004 };
    }),
    null,
  );
});
