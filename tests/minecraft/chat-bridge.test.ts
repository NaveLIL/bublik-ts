import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Client } from 'discord.js';
import { Events } from 'discord.js';
import {
  buildDiscordTellrawCommand,
  getChatPollDelayMs,
  selectMinecraftChatConfig,
  startChatBridge,
  stopChatBridge,
} from '../../src/modules/minecraft/services/chat-bridge';
import {
  startMinecraftStatusTracker,
  stopMinecraftStatusTracker,
} from '../../src/modules/minecraft/services/status-tracker';
import {
  getMinecraftGuildId,
  isMinecraftGuildEnabled,
  isMinecraftModuleConfigured,
} from '../../src/modules/minecraft/constants';

const validMinecraftEnvironment = {
  MINECRAFT_GUILD_ID: 'guild-a',
  RCON_HOST: 'mc.internal',
  RCON_PORT: '25575',
  RCON_PASSWORD: 'test-secret',
};

class FakeClient extends EventEmitter {
  logger = {
    child: () => ({
      info: () => {},
    }),
  };
}

test('chat poll delay grows exponentially and remains bounded', () => {
  assert.equal(getChatPollDelayMs(0), 3_000);
  assert.equal(getChatPollDelayMs(1), 6_000);
  assert.equal(getChatPollDelayMs(2), 12_000);
  assert.equal(getChatPollDelayMs(3), 24_000);
  assert.equal(getChatPollDelayMs(-5), 3_000);
  assert.equal(getChatPollDelayMs(100), 300_000);
});

test('MC chat routing is single-guild and fails closed when ownership is ambiguous', () => {
  const first = { guildId: 'guild-a', chatChannelId: 'channel-a' };
  const second = { guildId: 'guild-b', chatChannelId: 'channel-b' };
  const inactive = { guildId: 'guild-c', chatChannelId: null };

  assert.equal(selectMinecraftChatConfig([], null), null);
  assert.equal(selectMinecraftChatConfig([inactive], null), null);
  assert.equal(selectMinecraftChatConfig([first, inactive], null), first);
  assert.equal(selectMinecraftChatConfig([first, second], null), null);
  assert.equal(selectMinecraftChatConfig([first, second], 'guild-b'), second);
  assert.equal(selectMinecraftChatConfig([first, second], 'unknown-guild'), null);
});

test('Minecraft guild scope is explicit and fail-closed', () => {
  assert.equal(getMinecraftGuildId({}), null);
  assert.equal(isMinecraftModuleConfigured({}), false);
  assert.equal(isMinecraftGuildEnabled('guild-a', {}), false);
  assert.equal(
    isMinecraftGuildEnabled('guild-a', { MINECRAFT_GUILD_ID: 'guild-a' }),
    false,
    'a guild id alone must not enable RCON-backed commands'
  );
  assert.equal(isMinecraftModuleConfigured(validMinecraftEnvironment), true);
  assert.equal(
    isMinecraftGuildEnabled('guild-a', {
      ...validMinecraftEnvironment,
      MINECRAFT_GUILD_ID: ' guild-a ',
    }),
    true,
  );
  assert.equal(
    isMinecraftGuildEnabled('guild-b', validMinecraftEnvironment),
    false,
  );
});

test('Discord tellraw payload is JSON encoded and cannot inject another command', () => {
  const command = buildDiscordTellrawCommand(
    'name"}]\nstop',
    'hello "\n/op @a',
    'reply "\\\n',
  );
  assert.equal(command.includes('\n'), false);
  assert.match(command, /^tellraw @a /);

  const payload = JSON.parse(command.slice('tellraw @a '.length)) as Array<
    string | { text?: string }
  >;
  assert.equal(payload[2] && typeof payload[2] === 'object' ? payload[2].text : null, 'name"}]\nstop');
  assert.equal(payload.at(-1) && typeof payload.at(-1) === 'object' ? payload.at(-1)?.text : null, 'hello "\n/op @a');
});

test('chat bridge replaces and removes its Discord listener across reloads', async (t) => {
  const source = new FakeClient();
  const client = source as unknown as Client;
  t.after(() => stopChatBridge());

  await startChatBridge(client, { environment: validMinecraftEnvironment });
  assert.equal(source.listenerCount(Events.MessageCreate), 1);

  await startChatBridge(client, { environment: validMinecraftEnvironment });
  assert.equal(
    source.listenerCount(Events.MessageCreate),
    1,
    'reloading must replace the previous listener instead of accumulating listeners'
  );

  stopChatBridge();
  assert.equal(source.listenerCount(Events.MessageCreate), 0);
});

test('chat bridge creates no listener or poll scheduler without RCON configuration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const source = new FakeClient();
  const client = source as unknown as Client;
  let polls = 0;

  t.after(() => stopChatBridge());
  const started = await startChatBridge(client, {
    environment: {},
    baseDelayMs: 1,
    poll: async () => {
      polls += 1;
      return 'success';
    },
  });

  assert.equal(started, false);
  assert.equal(source.listenerCount(Events.MessageCreate), 0);
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(polls, 0);
});

test('status tracker remains stopped without RCON configuration', async (t) => {
  const client = new FakeClient() as unknown as Client;
  t.after(() => stopMinecraftStatusTracker());

  assert.equal(await startMinecraftStatusTracker(client, {}), false);
});

test('chat polling never overlaps and backs off after failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const source = new FakeClient();
  const client = source as unknown as Client;
  let calls = 0;
  let releaseFirstPoll: (() => void) | null = null;
  const firstPollGate = new Promise<void>((resolve) => {
    releaseFirstPoll = resolve;
  });

  t.after(() => stopChatBridge());
  await startChatBridge(client, {
    environment: validMinecraftEnvironment,
    baseDelayMs: 10,
    maxDelayMs: 80,
    poll: async () => {
      calls += 1;
      if (calls === 1) await firstPollGate;
      return 'failure';
    },
  });

  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(calls, 1);

  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(calls, 1, 'an unresolved poll must not be overlapped by another poll');

  releaseFirstPoll?.();
  await Promise.resolve();
  await Promise.resolve();

  t.mock.timers.tick(19);
  await Promise.resolve();
  assert.equal(calls, 1, 'the first failure must apply a 20 ms backoff');

  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls, 2);

  await Promise.resolve();
  t.mock.timers.tick(39);
  await Promise.resolve();
  assert.equal(calls, 2, 'the second failure must apply a 40 ms backoff');

  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls, 3);
});

test('chat bridge removes listeners immediately and drains an in-flight poll on stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const source = new FakeClient();
  const client = source as unknown as Client;
  let releasePoll: (() => void) | null = null;
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });

  await startChatBridge(client, {
    environment: validMinecraftEnvironment,
    baseDelayMs: 10,
    poll: async () => {
      await pollGate;
      return 'success';
    },
  });

  t.mock.timers.tick(10);
  await Promise.resolve();

  let stopped = false;
  const stopping = stopChatBridge().then(() => {
    stopped = true;
  });
  assert.equal(source.listenerCount(Events.MessageCreate), 0);
  await Promise.resolve();
  assert.equal(stopped, false, 'stop must wait for the active poll to settle');

  releasePoll?.();
  await stopping;
  assert.equal(stopped, true);
});
