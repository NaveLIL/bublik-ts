import test from 'node:test';
import assert from 'node:assert/strict';
import { NsType, VacationStatus } from '../src/modules/vacation/constants';
import {
  canReviewVacation,
  isNsInformationalVacation,
  isNsTransitionAllowed,
  isVacationTerminalStatus,
  isVacationTransitionAllowed,
  nsVacationActiveKey,
  selectSavedRoles,
  selectVacationSavedRoles,
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
