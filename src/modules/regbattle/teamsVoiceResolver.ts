import type { BublikClient } from '../../bot';

export type TeamsVoiceIntegration = typeof import('../teams/voiceIntegration');

type TeamsVoiceImporter = () => Promise<TeamsVoiceIntegration>;

export async function waitForTeamsVoiceIntegration(
  client: BublikClient,
  isCurrent: () => boolean,
  timeoutMs = 10_000,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isCurrent()) {
    if (client.moduleLoader.captureExecutionGuard('teams')) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/**
 * Resolve through Node's current require cache while the Teams module is an
 * active ModuleLoader generation. Every function call is tracked as legacy
 * Teams work so unload either waits for it or quarantines that exact generation.
 */
export async function resolveTeamsVoiceIntegration(
  client: BublikClient,
  importer: TeamsVoiceImporter = () => import('../teams/voiceIntegration'),
): Promise<TeamsVoiceIntegration | null> {
  const capturedGuard = client.moduleLoader.captureExecutionGuard('teams');
  if (!capturedGuard) return null;

  const integration = await importer();
  if (!capturedGuard.isCurrent()) return null;

  return new Proxy(integration, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => client.moduleLoader.runLegacyModuleWork(
        'teams',
        () => {
          if (!capturedGuard.isCurrent()) return null;
          return Reflect.apply(value, target, args);
        },
      );
    },
  });
}
