import assert from 'node:assert/strict';
import test from 'node:test';
import { ButtonStyle } from 'discord.js';
import { i18n } from '../../src/core/I18n';
import { buildControlPanelButtons } from '../../src/modules/regbattle/embeds';
import {
  applyNotifyToggle,
  areSquadNotificationsEnabled,
  isCurrentNotifyControlPanel,
  runForCurrentNotifyControlPanel,
  squadNotifyOffKey,
  TOGGLE_SQUAD_NOTIFICATIONS_LUA,
  toggleSquadNotifications,
  type NotifyToggleStore,
} from '../../src/modules/regbattle/notifyToggle';

class MemoryNotifyStore implements NotifyToggleStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    assert.equal(script, TOGGLE_SQUAD_NOTIFICATIONS_LUA);
    assert.equal(numberOfKeys, 1);
    const key = args[0];
    assert.ok(key);
    if (this.values.get(key) === '1') {
      this.values.delete(key);
      return 1;
    }
    this.values.set(key, '1');
    return 0;
  }
}

function notificationButton(locale: 'ru' | 'en', notificationsEnabled: boolean) {
  const rows = buildControlPanelButtons('squad', false, locale, notificationsEnabled);
  const components = rows.flatMap((row) => row.toJSON().components);
  const button = components.find((component) =>
    'custom_id' in component && component.custom_id === 'rb:notifytoggle:squad');
  assert.ok(button && 'label' in button && 'style' in button);
  return button;
}

i18n.load();

test('notification button displays the current state in Russian and English', () => {
  const ruEnabled = notificationButton('ru', true);
  assert.equal(ruEnabled.label, '🔔 Уведомления: ВКЛ');
  assert.equal(ruEnabled.style, ButtonStyle.Success);

  const ruDisabled = notificationButton('ru', false);
  assert.equal(ruDisabled.label, '🔕 Уведомления: ВЫКЛ');
  assert.equal(ruDisabled.style, ButtonStyle.Secondary);

  const enEnabled = notificationButton('en', true);
  assert.equal(enEnabled.label, '🔔 Notifications: ON');
  assert.equal(enEnabled.style, ButtonStyle.Success);

  const enDisabled = notificationButton('en', false);
  assert.equal(enDisabled.label, '🔕 Notifications: OFF');
  assert.equal(enDisabled.style, ButtonStyle.Secondary);
});

test('legacy notify-off key remains backwards compatible', async () => {
  const store = new MemoryNotifyStore();
  assert.equal(await areSquadNotificationsEnabled(store, 'squad'), true);

  store.values.set(squadNotifyOffKey('squad'), '1');
  assert.equal(await areSquadNotificationsEnabled(store, 'squad'), false);
});

test('stale control-panel guard does not invoke persistence', async () => {
  let persistCalls = 0;
  const persist = async () => {
    persistCalls++;
    return true;
  };

  assert.equal(isCurrentNotifyControlPanel('current-message', 'stale-message'), false);
  assert.equal(isCurrentNotifyControlPanel(null, 'stale-message'), false);
  assert.equal(isCurrentNotifyControlPanel('current-message', 'current-message'), true);

  assert.deepEqual(
    await runForCurrentNotifyControlPanel('current-message', 'stale-message', persist),
    { status: 'stale-panel' },
  );
  assert.equal(persistCalls, 0);

  assert.deepEqual(
    await runForCurrentNotifyControlPanel('current-message', 'current-message', persist),
    { status: 'current-panel', value: true },
  );
  assert.equal(persistCalls, 1);
});

test('Lua toggle returns the new positive state and concurrent toggles preserve parity', async () => {
  const store = new MemoryNotifyStore();

  assert.equal(await toggleSquadNotifications(store, 'squad'), false);
  assert.equal(store.values.get(squadNotifyOffKey('squad')), '1');
  assert.equal(await toggleSquadNotifications(store, 'squad'), true);
  assert.equal(store.values.has(squadNotifyOffKey('squad')), false);

  const outcomes = await Promise.all([
    toggleSquadNotifications(store, 'squad'),
    toggleSquadNotifications(store, 'squad'),
  ]);
  assert.deepEqual(outcomes, [false, true]);
  assert.equal(await areSquadNotificationsEnabled(store, 'squad'), true);
});

test('a projection failure cannot turn a committed toggle into a command failure', async () => {
  const events: string[] = [];
  const outcome = await applyNotifyToggle(
    'projection-failure',
    async () => {
      events.push('persist');
      return true;
    },
    (enabled) => [
      {
        name: 'pinger',
        run: () => { events.push(`pinger:${enabled}`); },
      },
      {
        name: 'control-panel',
        run: async () => {
          events.push('control-panel');
          throw new Error('Discord edit failed');
        },
      },
      {
        name: 'status-panel',
        run: () => { events.push('status-panel'); },
      },
    ],
  );

  assert.equal(outcome.notificationsEnabled, true);
  assert.deepEqual(events, ['persist', 'pinger:true', 'control-panel', 'status-panel']);
  assert.equal(outcome.projectionFailures.length, 1);
  assert.equal(outcome.projectionFailures[0].name, 'control-panel');
  assert.match(String(outcome.projectionFailures[0].error), /Discord edit failed/);
});

test('status-panel failure is isolated and the pinger is recalculated once', async () => {
  let pingerRuns = 0;
  const outcome = await applyNotifyToggle(
    'status-panel-failure',
    async () => false,
    () => [
      { name: 'pinger', run: () => { pingerRuns++; } },
      { name: 'status-panel', run: async () => { throw new Error('panel unavailable'); } },
    ],
  );

  assert.equal(outcome.notificationsEnabled, false);
  assert.equal(pingerRuns, 1);
  assert.deepEqual(outcome.projectionFailures.map((failure) => failure.name), ['status-panel']);
});

test('a persistence failure runs no projections and remains a real command error', async () => {
  let builtProjections = false;
  await assert.rejects(
    applyNotifyToggle(
      'persistence-failure',
      async () => { throw new Error('Redis unavailable'); },
      () => {
        builtProjections = true;
        return [];
      },
    ),
    /Redis unavailable/,
  );
  assert.equal(builtProjections, false);
});

test('a projection-plan bug is isolated after persistence', async () => {
  const outcome = await applyNotifyToggle(
    'projection-plan-failure',
    async () => true,
    () => { throw new Error('render failed'); },
  );
  assert.equal(outcome.notificationsEnabled, true);
  assert.equal(outcome.projectionFailures[0].name, 'projection-plan');
});

test('concurrent toggles serialize persistence and projections for one squad', async () => {
  const store = new MemoryNotifyStore();
  const events: string[] = [];
  let projectedState: boolean | null = null;
  let releaseFirstProjection!: () => void;
  let markFirstProjectionStarted!: () => void;
  const firstProjectionStarted = new Promise<void>((resolve) => {
    markFirstProjectionStarted = resolve;
  });
  const firstProjectionGate = new Promise<void>((resolve) => {
    releaseFirstProjection = resolve;
  });

  const runToggle = () => applyNotifyToggle(
    'serialized-squad',
    async () => {
      const enabled = await toggleSquadNotifications(store, 'serialized-squad');
      events.push(`persist:${enabled}`);
      return enabled;
    },
    (enabled) => [{
      name: 'control-panel',
      run: async () => {
        events.push(`project:start:${enabled}`);
        if (!enabled) {
          markFirstProjectionStarted();
          await firstProjectionGate;
        }
        projectedState = enabled;
        events.push(`project:end:${enabled}`);
      },
    }],
  );

  const first = runToggle();
  const second = runToggle();
  await firstProjectionStarted;

  assert.equal(
    await areSquadNotificationsEnabled(store, 'serialized-squad'),
    false,
    'the second persistence operation must remain queued behind the first projection',
  );
  assert.deepEqual(events, ['persist:false', 'project:start:false']);

  releaseFirstProjection();
  const outcomes = await Promise.all([first, second]);

  assert.deepEqual(outcomes.map((outcome) => outcome.notificationsEnabled), [false, true]);
  assert.deepEqual(events, [
    'persist:false',
    'project:start:false',
    'project:end:false',
    'persist:true',
    'project:start:true',
    'project:end:true',
  ]);
  assert.equal(await areSquadNotificationsEnabled(store, 'serialized-squad'), true);
  assert.equal(projectedState, true, 'the final button projection must match final Redis parity');
});
