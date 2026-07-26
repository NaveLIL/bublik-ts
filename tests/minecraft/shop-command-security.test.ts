import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSafeMinecraftShopPrice,
  MAX_MINECRAFT_SHOP_PRICE,
} from '../../src/modules/minecraft/database';
import {
  validateShopCommandTemplate,
} from '../../src/modules/minecraft/services/shop-command-policy';

test('Minecraft shop prices are positive bounded safe integers', () => {
  assert.equal(isSafeMinecraftShopPrice(1), true);
  assert.equal(isSafeMinecraftShopPrice(MAX_MINECRAFT_SHOP_PRICE), true);

  for (const price of [
    -10,
    0,
    1.5,
    MAX_MINECRAFT_SHOP_PRICE + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(isSafeMinecraftShopPrice(price), false, String(price));
  }
});

test('Minecraft shop accepts direct give templates and existing multi-item format', () => {
  assert.equal(
    validateShopCommandTemplate('give {username} minecraft:diamond 5').ok,
    true
  );
  assert.equal(
    validateShopCommandTemplate(
      'give {username} minecraft:helmet 1; give {username} minecraft:sword 1'
    ).ok,
    true
  );
  assert.equal(
    validateShopCommandTemplate(
      'give {username} minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5}}] 1'
    ).ok,
    true
  );
});

test('Minecraft shop rejects selectors and arbitrary RCON capabilities', () => {
  for (const template of [
    'stop',
    'op {username}',
    'execute as {username} run stop',
    'give @a minecraft:diamond 5',
    'give {username} minecraft:diamond 1\nstop',
    'give {username} minecraft:diamond 1; stop',
    'give {username} minecraft:diamond 1; give @a minecraft:diamond 1',
    'give minecraft:diamond 1',
    'give {username} minecraft:diamond 2147483648',
  ]) {
    assert.equal(validateShopCommandTemplate(template).ok, false, template);
  }
});
