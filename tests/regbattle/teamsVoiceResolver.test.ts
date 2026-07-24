import test from 'node:test';
import assert from 'node:assert/strict';
import type { BublikClient } from '../../src/bot';
import {
  resolveTeamsVoiceIntegration,
  waitForTeamsVoiceIntegration,
  type TeamsVoiceIntegration,
} from '../../src/modules/regbattle/teamsVoiceResolver';

function fakeClient(isActive: () => boolean, onRun: () => void = () => undefined): BublikClient {
  const guard = { isCurrent: isActive };
  return {
    moduleLoader: {
      captureExecutionGuard: () => isActive() ? guard : null,
      async runLegacyModuleWork(_name: string, execute: () => unknown) {
        if (!isActive()) return null;
        onRun();
        return await execute();
      },
    },
  } as unknown as BublikClient;
}

test('RegBattle resolves the current Teams voice integration generation on every call', async () => {
  let generation = 0;
  const importer = async () => ({
    generation: ++generation,
  } as unknown as TeamsVoiceIntegration);
  const client = fakeClient(() => true);

  const first = await resolveTeamsVoiceIntegration(client, importer) as unknown as { generation: number };
  const second = await resolveTeamsVoiceIntegration(client, importer) as unknown as { generation: number };

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.notEqual(first, second);
});

test('RegBattle neither imports nor invokes an unloaded Teams generation', async () => {
  let active = false;
  let imports = 0;
  let calls = 0;
  let trackedRuns = 0;
  const client = fakeClient(() => active, () => { trackedRuns++; });
  const importer = async () => {
    imports++;
    return {
      async resolveTeamSquad() {
        calls++;
        return { teamId: 'team' };
      },
    } as unknown as TeamsVoiceIntegration;
  };

  assert.equal(await resolveTeamsVoiceIntegration(client, importer), null);
  assert.equal(imports, 0);

  active = true;
  const integration = await resolveTeamsVoiceIntegration(client, importer);
  assert.ok(integration);
  active = false;
  assert.equal(await integration.resolveTeamSquad('voice', 'guild'), null);
  assert.equal(calls, 0);
  assert.equal(trackedRuns, 0);
});

test('RegBattle tracks Teams calls under the active module generation', async () => {
  let trackedRuns = 0;
  const client = fakeClient(() => true, () => { trackedRuns++; });
  const integration = await resolveTeamsVoiceIntegration(client, async () => ({
    async hasVoiceInvite() { return true; },
  } as unknown as TeamsVoiceIntegration));

  assert.ok(integration);
  assert.equal(await integration.hasVoiceInvite('voice', 'user'), true);
  assert.equal(trackedRuns, 1);
});

test('RegBattle boot waits briefly for the later-loaded Teams module', async () => {
  let probes = 0;
  const client = fakeClient(() => ++probes >= 3);
  assert.equal(
    await waitForTeamsVoiceIntegration(client, () => true, 100, 1),
    true,
  );
  assert.ok(probes >= 3);

  assert.equal(
    await waitForTeamsVoiceIntegration(fakeClient(() => false), () => false, 100, 1),
    false,
  );
});
