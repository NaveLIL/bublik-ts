import assert from 'node:assert/strict';
import test from 'node:test';
import type { PbPingerDisplayStatus } from '../../src/modules/regbattle/pingerDisplayStatus';

async function loadEmbedBuilder() {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  const [{ i18n }, embeds] = await Promise.all([
    import('../../src/core/I18n'),
    import('../../src/modules/regbattle/embeds'),
  ]);
  i18n.load();
  return embeds.buildStatusPanelEmbed;
}

function individualStatus(): PbPingerDisplayStatus {
  return {
    mode: 'individual_safe',
    reason: 'unsafe_population',
    delivery: 'individual_mentions',
    audience: 'recruiting',
    activeSquadCount: 1,
    allFull: false,
    eligibleIndividualCount: 19,
    exclusions: { vacation: 3, played: 0, inPb: 0, bot: 0 },
    conflictingExclusionCount: 3,
    noProgressCount: 0,
    escalateAfter: 6,
  };
}

test('PB status panel explains safe notification mode without replacing the standard footer', async () => {
  const buildStatusPanelEmbed = await loadEmbedBuilder();
  const { embed } = buildStatusPanelEmbed(
    [{
      number: 1,
      count: 1,
      size: 8,
      voiceChannelId: '123456789012345678',
      ownerTag: 'navel_erez',
      members: [{ id: '1', displayName: 'NaveL' }],
      notifyOff: false,
    }],
    [],
    [],
    [],
    'ru',
    individualStatus(),
    9,
    19,
  );
  const json = embed.toJSON();
  const notifications = json.fields?.find((field) => field.name === '🔔 Режим уведомлений');

  assert.equal(json.footer?.text, '© NaveL for EREZ 2024–2026');
  assert.ok(notifications);
  assert.match(notifications.value, /^> \*\*Персональный режим\*\*/);
  assert.match(notifications.value, /в отпуске с пинг-ролью — 3/);
  assert.match(notifications.value, /\*\*Комплектование:\*\* требуется ещё 7 бойцов$/);
  assert.doesNotMatch(notifications.value, /🛡|📢|🎯|✅|⏳/u);
});

test('PB status panel chunks several full squads within Discord field limits', async () => {
  const buildStatusPanelEmbed = await loadEmbedBuilder();
  const longName = 'ОченьДлинноеИмяУчастника123456789';
  const squads = Array.from({ length: 3 }, (_, squadIndex) => ({
    number: squadIndex + 1,
    count: 8,
    size: 8,
    voiceChannelId: `12345678901234567${squadIndex}`,
    ownerTag: `commander_${squadIndex}`,
    members: Array.from({ length: 8 }, (_, memberIndex) => ({
      id: `${squadIndex}-${memberIndex}`,
      displayName: `${longName}${memberIndex}`,
    })),
    notifyOff: false,
  }));
  const status: PbPingerDisplayStatus = {
    ...individualStatus(),
    mode: 'full_role',
    reason: 'safe_population',
    delivery: 'role_mention',
    audience: 'reserve',
    allFull: true,
    exclusions: { vacation: 0, played: 0, inPb: 0, bot: 0 },
    conflictingExclusionCount: 0,
  };

  const { embed } = buildStatusPanelEmbed(squads, [], [], [], 'ru', status, 0, 19);
  const squadFields = embed.toJSON().fields?.filter((field) =>
    field.name.startsWith('📋 Отряды')) ?? [];
  assert.ok(squadFields.length >= 2);
  assert.ok(squadFields.every((field) => field.value.length <= 1_024));
});

test('PB status panel keeps the whole embed within Discord limits and summarizes hidden squads', async () => {
  const buildStatusPanelEmbed = await loadEmbedBuilder();
  const squads = Array.from({ length: 30 }, (_, squadIndex) => ({
    number: squadIndex + 1,
    count: 8,
    size: 8,
    voiceChannelId: `22345678901234567${squadIndex}`,
    ownerTag: `CommanderName123456789012345${squadIndex}`,
    members: Array.from({ length: 8 }, (_, memberIndex) => ({
      id: `${squadIndex}-${memberIndex}`,
      displayName: `FighterName1234567890123456${memberIndex}`,
    })),
    notifyOff: false,
  }));
  const status: PbPingerDisplayStatus = {
    ...individualStatus(),
    mode: 'full_role',
    reason: 'safe_population',
    delivery: 'role_mention',
    audience: 'reserve',
    activeSquadCount: squads.length,
    allFull: true,
    exclusions: { vacation: 0, played: 0, inPb: 0, bot: 0 },
    conflictingExclusionCount: 0,
  };

  const json = buildStatusPanelEmbed(squads, [], [], [], 'ru', status, 0, 30).embed.toJSON();
  const fields = json.fields ?? [];
  const totalTextLength = (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.author?.name.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  const squadText = fields
    .filter((field) => field.name.startsWith('📋 Отряды'))
    .map((field) => field.value)
    .join('\n');

  assert.ok(fields.length <= 25);
  assert.ok(fields.every((field) => field.value.length <= 1_024));
  assert.ok(totalTextLength <= 6_000);
  assert.match(squadText, /\*… ещё \d+ (?:отряд|отряда|отрядов)\*/u);
  assert.ok(fields.some((field) => field.name === '🔔 Режим уведомлений'));
});

test('PB no-target mode explains why nobody can be called', async () => {
  const buildStatusPanelEmbed = await loadEmbedBuilder();
  const status: PbPingerDisplayStatus = {
    ...individualStatus(),
    mode: 'no_targets',
    reason: 'no_eligible_targets',
    delivery: 'channel_message',
    eligibleIndividualCount: 0,
    exclusions: { vacation: 4, played: 5, inPb: 1, bot: 2 },
    conflictingExclusionCount: 12,
  };
  const { embed } = buildStatusPanelEmbed(
    [{
      number: 1,
      count: 1,
      size: 8,
      voiceChannelId: '323456789012345678',
      ownerTag: 'commander',
      members: [{ id: '1', displayName: 'Боец' }],
      notifyOff: false,
    }],
    [],
    [],
    [],
    'ru',
    status,
    0,
    12,
  );
  const notifications = embed.toJSON().fields?.find((field) =>
    field.name === '🔔 Режим уведомлений');

  assert.ok(notifications);
  assert.match(notifications.value, /Исключены из вызова:/);
  assert.match(notifications.value, /в отпуске с пинг-ролью — 4/);
  assert.match(notifications.value, /уже играли сегодня — 5/);
  assert.match(notifications.value, /уже находятся в ПБ — 1/);
  assert.match(notifications.value, /боты — 2/);
});
