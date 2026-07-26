import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMinecraftStatusEmbed } from '../../src/modules/minecraft/embeds';
import { parseTpsResponse } from '../../src/modules/minecraft/services/status-tracker';

test('TPS parser reads the first reported interval without inventing a value', () => {
  assert.equal(parseTpsResponse('TPS from last 1m, 5m, 15m: 19.75, 19.50, 19.25'), 19.75);
  assert.equal(parseTpsResponse('TPS: 21.50'), 20);
  assert.equal(parseTpsResponse('TPS unavailable'), undefined);
  assert.equal(parseTpsResponse('TPS: -1'), undefined);
});

test('online status embed labels unavailable runtime metrics honestly', () => {
  const embed = buildMinecraftStatusEmbed({
    online: true,
    address: 'example.invalid:25565',
    playersOnline: 0,
    playersMax: 20,
    playerList: [],
  }).toJSON();

  const stability = embed.fields?.find((field) => field.name.includes('Стабильность'));
  const services = embed.fields?.find((field) => field.name.includes('Сеть'));
  assert.match(stability?.value ?? '', /TPS.*недоступно/);
  assert.match(stability?.value ?? '', /MSPT.*недоступно/);
  assert.doesNotMatch(stability?.value ?? '', /20\.0/);
  assert.match(services?.value ?? '', /не проверяется ботом/);
});
