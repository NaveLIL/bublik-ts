const NOTIFY_OFF_KEY_PREFIX = 'rb:notify_off';

/** Minimal Redis surface used by the squad notification preference. */
export interface NotifyToggleStore {
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export const TOGGLE_SQUAD_NOTIFICATIONS_LUA = `
local key = KEYS[1]
if redis.call('GET', key) == '1' then
  redis.call('DEL', key)
  return 1
end
redis.call('SET', key, '1')
return 0
`;

export function squadNotifyOffKey(squadId: string): string {
  return `${NOTIFY_OFF_KEY_PREFIX}:${squadId}`;
}

/**
 * Existing deployments encode disabled notifications as the value "1".
 * A missing key therefore remains the backwards-compatible enabled default.
 */
export async function areSquadNotificationsEnabled(
  store: NotifyToggleStore,
  squadId: string,
): Promise<boolean> {
  const value = await store.get(squadNotifyOffKey(squadId));
  return value !== '1';
}

/** Atomically toggle the legacy notify-off key and return the new positive state. */
export async function toggleSquadNotifications(
  store: NotifyToggleStore,
  squadId: string,
): Promise<boolean> {
  const result = await store.eval(
    TOGGLE_SQUAD_NOTIFICATIONS_LUA,
    1,
    squadNotifyOffKey(squadId),
  );

  if (result === 1 || result === '1') return true;
  if (result === 0 || result === '0') return false;
  throw new Error(`Unexpected squad notification toggle result: ${String(result)}`);
}

export type NotifyToggleProjectionName = 'pinger' | 'control-panel' | 'status-panel';

export interface NotifyToggleProjection {
  name: NotifyToggleProjectionName;
  run(): void | Promise<void>;
}

export interface NotifyToggleProjectionFailure {
  name: NotifyToggleProjectionName | 'projection-plan';
  error: unknown;
}

export interface NotifyToggleOutcome {
  notificationsEnabled: boolean;
  projectionFailures: NotifyToggleProjectionFailure[];
}

export type CurrentNotifyControlPanelResult<T> =
  | { status: 'stale-panel' }
  | { status: 'current-panel'; value: T };

export function isCurrentNotifyControlPanel(
  authoritativeMessageId: string | null | undefined,
  interactionMessageId: string,
): boolean {
  return typeof authoritativeMessageId === 'string' &&
    authoritativeMessageId.length > 0 &&
    authoritativeMessageId === interactionMessageId;
}

/** Run an operation only when the interaction belongs to the canonical panel. */
export async function runForCurrentNotifyControlPanel<T>(
  authoritativeMessageId: string | null | undefined,
  interactionMessageId: string,
  operation: () => Promise<T>,
): Promise<CurrentNotifyControlPanelResult<T>> {
  if (!isCurrentNotifyControlPanel(authoritativeMessageId, interactionMessageId)) {
    return { status: 'stale-panel' };
  }
  return { status: 'current-panel', value: await operation() };
}

const squadToggleQueues = new Map<string, Promise<void>>();

async function applyNotifyToggleUnserialized(
  persist: () => Promise<boolean>,
  buildProjections: (notificationsEnabled: boolean) => readonly NotifyToggleProjection[],
): Promise<NotifyToggleOutcome> {
  const notificationsEnabled = await persist();
  const projectionFailures: NotifyToggleProjectionFailure[] = [];

  let projections: readonly NotifyToggleProjection[];
  try {
    projections = buildProjections(notificationsEnabled);
  } catch (error) {
    return {
      notificationsEnabled,
      projectionFailures: [{ name: 'projection-plan', error }],
    };
  }

  for (const projection of projections) {
    try {
      await projection.run();
    } catch (error) {
      projectionFailures.push({ name: projection.name, error });
    }
  }

  return { notificationsEnabled, projectionFailures };
}

/**
 * Serialize the whole persist-and-project operation per squad. Redis toggling
 * is atomic, but without this local queue two Discord edits could finish in
 * reverse order and leave a stale button in a single-process deployment.
 * Projection failures remain isolated after persistence succeeds.
 */
export async function applyNotifyToggle(
  squadId: string,
  persist: () => Promise<boolean>,
  buildProjections: (notificationsEnabled: boolean) => readonly NotifyToggleProjection[],
): Promise<NotifyToggleOutcome> {
  const previous = squadToggleQueues.get(squadId) ?? Promise.resolve();
  const execution = previous
    .catch(() => undefined)
    .then(() => applyNotifyToggleUnserialized(persist, buildProjections));
  const queueTail = execution.then(() => undefined, () => undefined);
  squadToggleQueues.set(squadId, queueTail);

  try {
    return await execution;
  } finally {
    if (squadToggleQueues.get(squadId) === queueTail) {
      squadToggleQueues.delete(squadId);
    }
  }
}
