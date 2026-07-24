import assert from 'node:assert/strict';
import test from 'node:test';
import type { Guild, GuildMember, VoiceChannel } from 'discord.js';
import {
  isDmPingSendOutcomeAmbiguous,
  resolveDmPingDispatchFence,
  shouldFinalizeDmPingCooldown,
  type DmPingDispatchFenceDependencies,
} from '../../src/modules/regbattle/handlers';

const guild = { id: 'guild' } as Guild;

function squad(overrides: Record<string, unknown> = {}) {
  return {
    id: 'squad',
    guildId: guild.id,
    ownerId: 'commander',
    voiceChannelId: 'target-voice',
    airChannelId: null,
    number: 1,
    config: {
      pingRoleId: 'ping-role',
      playedTodayRoleId: 'played-role',
      reserveChannelId: 'reserve-voice',
      squadSize: 8,
    },
    ...overrides,
  } as any;
}

function member(
  voiceChannel: { value: string | null },
  roleIds: Map<string, unknown> = new Map([['ping-role', true]]),
): GuildMember {
  return {
    id: 'fighter',
    guild,
    user: { bot: false, tag: 'fighter#0001' },
    roles: { cache: roleIds },
    voice: {
      get channelId() {
        return voiceChannel.value;
      },
    },
  } as unknown as GuildMember;
}

function voiceChannel(
  occupants: Map<string, unknown> = new Map(),
): VoiceChannel {
  return {
    id: 'target-voice',
    guildId: guild.id,
    members: occupants,
  } as unknown as VoiceChannel;
}

function eligibleSnapshot(excludedUserIds: ReadonlySet<string> = new Set()) {
  return {
    guildId: guild.id,
    excludedUserIds,
    vacationRoleId: 'vacation-role',
  };
}

test('DM dispatch rebuilds topology per recipient and skips a fighter entering a newly created PB', async () => {
  const currentVoice = { value: null as string | null };
  const currentMember = member(currentVoice);
  const targetChannel = voiceChannel();
  let squadReads = 0;
  let topologyReads = 0;
  let memberReads = 0;
  let eligibilityReads = 0;

  const dependencies: DmPingDispatchFenceDependencies = {
    getSquadById: async () => {
      squadReads++;
      return squad();
    },
    getPbChannelIds: async () => {
      topologyReads++;
      if (topologyReads === 2) currentVoice.value = 'new-pb-voice';
      return topologyReads === 1
        ? ['target-voice']
        : ['target-voice', 'new-pb-voice'];
    },
    getSquadByVoice: async () => null,
    fetchMember: async () => {
      memberReads++;
      return currentMember;
    },
    loadEligibility: async () => {
      eligibilityReads++;
      return eligibleSnapshot();
    },
    fetchVoiceChannel: async () => targetChannel,
  };

  const first = await resolveDmPingDispatchFence(
    guild,
    'squad',
    'commander',
    'fighter',
    dependencies,
  );
  assert.equal(first.status, 'send');

  const second = await resolveDmPingDispatchFence(
    guild,
    'squad',
    'commander',
    'fighter',
    dependencies,
  );
  assert.deepEqual(second, { status: 'skip-recipient', reason: 'ineligible' });
  assert.equal(squadReads, 4, 'the exact target is fenced twice per recipient');
  assert.equal(topologyReads, 2, 'PB topology is reloaded for every recipient');
  assert.equal(memberReads, 2);
  assert.equal(eligibilityReads, 2);
});

test('DM dispatch classifies exact current voice after member fetch even when broad topology is older', async () => {
  const currentVoice = { value: null as string | null };
  const currentMember = member(currentVoice);
  const events: string[] = [];
  const dependencies: DmPingDispatchFenceDependencies = {
    getSquadById: async () => squad(),
    fetchMember: async () => {
      events.push('member');
      await Promise.resolve();
      currentVoice.value = 'new-pb-voice';
      return currentMember;
    },
    fetchVoiceChannel: async () => voiceChannel(),
    getPbChannelIds: async () => {
      events.push('topology');
      return ['target-voice'];
    },
    getSquadByVoice: async (channelId) => {
      events.push(`exact:${channelId}`);
      return squad({
        id: 'new-squad',
        ownerId: 'other-commander',
        voiceChannelId: 'new-pb-voice',
      });
    },
    loadEligibility: async () => eligibleSnapshot(),
  };

  assert.deepEqual(
    await resolveDmPingDispatchFence(
      guild,
      'squad',
      'commander',
      'fighter',
      dependencies,
    ),
    { status: 'skip-recipient', reason: 'ineligible' },
  );
  assert.deepEqual(events, ['member', 'topology', 'exact:new-pb-voice']);
});

test('DM dispatch observes target capacity after the final topology await', async () => {
  const currentMember = member({ value: null });
  const occupants = new Map<string, any>();
  const targetChannel = voiceChannel(occupants);
  const dependencies: DmPingDispatchFenceDependencies = {
    getSquadById: async () => squad(),
    getPbChannelIds: async () => {
      for (let index = 0; index < 8; index++) {
        occupants.set(`occupant-${index}`, {
          id: `occupant-${index}`,
          user: { bot: false },
        });
      }
      return ['target-voice'];
    },
    getSquadByVoice: async () => null,
    fetchMember: async () => currentMember,
    loadEligibility: async () => eligibleSnapshot(),
    fetchVoiceChannel: async () => targetChannel,
  };

  assert.deepEqual(
    await resolveDmPingDispatchFence(
      guild,
      'squad',
      'commander',
      'fighter',
      dependencies,
    ),
    { status: 'stop-batch', reason: 'target-full' },
  );
});

test('DM dispatch stops if the target disappears, changes owner or loses topology', async () => {
  const currentMember = member({ value: null });
  const targetChannel = voiceChannel();
  const scenarios = [
    {
      name: 'deleted before send',
      squadReads: [squad(), null],
      topology: ['target-voice'],
      expected: { status: 'stop-batch', reason: 'target-missing' },
    },
    {
      name: 'owner transferred before send',
      squadReads: [squad(), squad({ ownerId: 'successor' })],
      topology: ['target-voice'],
      expected: { status: 'stop-batch', reason: 'target-missing' },
    },
    {
      name: 'target channel changed before send',
      squadReads: [squad(), squad({ voiceChannelId: 'replacement-voice' })],
      topology: ['replacement-voice'],
      expected: { status: 'stop-batch', reason: 'target-changed' },
    },
    {
      name: 'target row absent from final topology',
      squadReads: [squad(), squad()],
      topology: [],
      expected: { status: 'stop-batch', reason: 'target-topology-mismatch' },
    },
  ];

  for (const scenario of scenarios) {
    let readIndex = 0;
    const dependencies: DmPingDispatchFenceDependencies = {
      getSquadById: async () => scenario.squadReads[readIndex++] as any,
      getPbChannelIds: async () => scenario.topology,
      getSquadByVoice: async () => null,
      fetchMember: async () => currentMember,
      loadEligibility: async () => eligibleSnapshot(),
      fetchVoiceChannel: async () => targetChannel,
    };
    assert.deepEqual(
      await resolveDmPingDispatchFence(
        guild,
        'squad',
        'commander',
        'fighter',
        dependencies,
      ),
      scenario.expected,
      scenario.name,
    );
  }

  const missingChannelDependencies: DmPingDispatchFenceDependencies = {
    getSquadById: async () => squad(),
    getPbChannelIds: async () => ['target-voice'],
    getSquadByVoice: async () => null,
    fetchMember: async () => currentMember,
    loadEligibility: async () => eligibleSnapshot(),
    fetchVoiceChannel: async () => null,
  };
  assert.deepEqual(
    await resolveDmPingDispatchFence(
      guild,
      'squad',
      'commander',
      'fighter',
      missingChannelDependencies,
    ),
    { status: 'stop-batch', reason: 'target-channel-missing' },
  );
});

test('DM dispatch applies fresh vacation, role and reserve voice eligibility', async () => {
  const cases = [
    {
      name: 'durable vacation',
      voiceId: null,
      roleIds: new Map([['ping-role', true]]),
      snapshot: eligibleSnapshot(new Set(['fighter'])),
    },
    {
      name: 'vacation role',
      voiceId: null,
      roleIds: new Map([['ping-role', true], ['vacation-role', true]]),
      snapshot: eligibleSnapshot(),
    },
    {
      name: 'ping role removed',
      voiceId: null,
      roleIds: new Map(),
      snapshot: eligibleSnapshot(),
    },
    {
      name: 'already in reserve',
      voiceId: 'reserve-voice',
      roleIds: new Map([['ping-role', true]]),
      snapshot: eligibleSnapshot(),
    },
  ];

  for (const scenario of cases) {
    const currentMember = member(
      { value: scenario.voiceId },
      scenario.roleIds,
    );
    const dependencies: DmPingDispatchFenceDependencies = {
      getSquadById: async () => squad(),
      getPbChannelIds: async () => ['target-voice'],
      getSquadByVoice: async () => null,
      fetchMember: async () => currentMember,
      loadEligibility: async () => scenario.snapshot,
      fetchVoiceChannel: async () => voiceChannel(),
    };
    assert.deepEqual(
      await resolveDmPingDispatchFence(
        guild,
        'squad',
        'commander',
        'fighter',
        dependencies,
      ),
      { status: 'skip-recipient', reason: 'ineligible' },
      scenario.name,
    );
  }
});

test('an outcome-ambiguous DM send keeps the conservative cooldown claim', () => {
  assert.equal(isDmPingSendOutcomeAmbiguous({ code: 'ECONNRESET' }), true);
  assert.equal(isDmPingSendOutcomeAmbiguous({ status: 503 }), true);
  assert.equal(isDmPingSendOutcomeAmbiguous(new Error('lost response')), true);
  assert.equal(isDmPingSendOutcomeAmbiguous({ status: 403, code: 50007 }), false);
  assert.equal(isDmPingSendOutcomeAmbiguous({ code: 50007 }), false);
  assert.equal(shouldFinalizeDmPingCooldown(false), true);
  assert.equal(shouldFinalizeDmPingCooldown(true), false);
});
