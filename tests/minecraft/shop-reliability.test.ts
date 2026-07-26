import test from 'node:test';
import assert from 'node:assert/strict';
import { GuildMember } from 'discord.js';
import {
  isSafeMinecraftShopPrice,
  MinecraftAccountData,
  MinecraftShopItemData,
} from '../../src/modules/minecraft/database';
import {
  MinecraftPurchaseDependencies,
  purchaseMinecraftShopItem,
} from '../../src/modules/minecraft/services/economy-bridge';
import { validateShopCommandTemplate } from '../../src/modules/minecraft/services/shop-command-policy';
import { buildMinecraftPurchaseFailureText } from '../../src/modules/minecraft/embeds';

function account(): MinecraftAccountData {
  const now = new Date('2026-07-27T00:00:00.000Z');
  return {
    id: 'account',
    guildId: 'guild-a',
    discordId: 'user',
    minecraftUsername: 'SafePlayer',
    minecraftUuid: null,
    linkCode: null,
    linkCodeExpiresAt: null,
    isLinked: true,
    linkedAt: now,
    playtimeMinutes: 0,
    lastRewardAt: null,
    totalEarnedShekels: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function item(overrides: Partial<MinecraftShopItemData> = {}): MinecraftShopItemData {
  const now = new Date('2026-07-27T00:00:00.000Z');
  return {
    id: 'item',
    guildId: 'guild-a',
    name: 'Safe item',
    description: null,
    priceShekels: 100,
    rconCommand: 'give {username} minecraft:diamond 1',
    iconEmoji: '📦',
    category: 'resources',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface Audit {
  id: string;
  guildId: string;
  userId: string;
  type: string;
  amount: number;
  balance: number;
  profileId: string;
  targetId: string;
  details: string;
}

function fakeDatabase(initialWallet: number) {
  let wallet = initialWallet;
  let nextAuditId = 1;
  const audits: Audit[] = [];
  const debitWheres: unknown[] = [];

  const economyProfile = {
    async findUnique() {
      return { id: 'profile', wallet };
    },
    async update(args: any) {
      wallet += args.data.wallet.increment;
      return { id: 'profile', wallet };
    },
    async updateMany(args: any) {
      debitWheres.push(args.where);
      if (wallet < args.where.wallet.gte) return { count: 0 };
      wallet -= args.data.wallet.decrement;
      return { count: 1 };
    },
  };

  const economyTransaction = {
    async create(args: any) {
      const audit = { id: `audit-${nextAuditId++}`, ...args.data } as Audit;
      audits.push(audit);
      return audit;
    },
    async findFirst(args: any) {
      return audits.find((audit) =>
        audit.guildId === args.where.guildId
        && audit.userId === args.where.userId
        && audit.type === args.where.type
        && audit.targetId === args.where.targetId
      ) ?? null;
    },
    async updateMany(args: any) {
      const audit = audits.find((candidate) =>
        candidate.id === args.where.id
        && (!args.where.guildId || candidate.guildId === args.where.guildId)
        && (!args.where.userId || candidate.userId === args.where.userId)
        && (!args.where.profileId || candidate.profileId === args.where.profileId)
        && candidate.type === args.where.type
      );
      if (!audit) return { count: 0 };
      Object.assign(audit, args.data);
      return { count: 1 };
    },
  };

  const tx = { economyProfile, economyTransaction };
  const db = {
    ...tx,
    async $transaction<T>(operation: (client: typeof tx) => Promise<T>) {
      return operation(tx);
    },
  };

  return {
    db,
    audits,
    debitWheres,
    get wallet() {
      return wallet;
    },
  };
}

function dependencies(
  state: ReturnType<typeof fakeDatabase>,
  overrides: Partial<MinecraftPurchaseDependencies> = {}
): Partial<MinecraftPurchaseDependencies> {
  return {
    getAccount: async () => account(),
    getShopItem: async () => item(),
    getDb: () => state.db as never,
    executeCommand: async () => ({ success: true }),
    ...overrides,
  };
}

const member = { id: 'user' } as GuildMember;

test('shop command policy permits current give templates and rejects generic RCON', () => {
  const safe = validateShopCommandTemplate(
    'give {username} minecraft:diamond 16; '
    + 'give {username} minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5}}] 1'
  );
  assert.equal(safe.ok, true);
  if (safe.ok) assert.equal(safe.commands.length, 2);

  for (const unsafe of [
    'stop',
    'op {username}',
    'give @a minecraft:diamond 1',
    'give {username} minecraft:diamond 1; stop',
    'give {username} minecraft:diamond {username}',
    'give {username} minecraft:diamond 1;',
  ]) {
    assert.equal(validateShopCommandTemplate(unsafe).ok, false, unsafe);
  }
});

test('shop price policy rejects zero, negative, fractional and overflowing values', () => {
  assert.equal(isSafeMinecraftShopPrice(1), true);
  assert.equal(isSafeMinecraftShopPrice(2_147_483_647), true);
  assert.equal(isSafeMinecraftShopPrice(0), false);
  assert.equal(isSafeMinecraftShopPrice(-1), false);
  assert.equal(isSafeMinecraftShopPrice(1.5), false);
  assert.equal(isSafeMinecraftShopPrice(2_147_483_648), false);
});

test('purchase requests the item in the current guild and atomically debits the wallet', async () => {
  const state = fakeDatabase(150);
  const lookups: Array<[string, string]> = [];
  const executed: string[] = [];

  const result = await purchaseMinecraftShopItem('guild-a', member, 'item', dependencies(state, {
    getShopItem: async (guildId, itemId) => {
      lookups.push([guildId, itemId]);
      return item();
    },
    executeCommand: async (command) => {
      executed.push(command);
      return { success: true };
    },
  }));

  assert.equal(result.success, true);
  assert.equal(result.newBalance, 50);
  assert.equal(state.wallet, 50);
  assert.deepEqual(lookups, [['guild-a', 'item']]);
  assert.deepEqual(state.debitWheres[0], {
    id: 'profile',
    guildId: 'guild-a',
    userId: 'user',
    wallet: { gte: 100 },
  });
  assert.equal(executed[0], 'give SafePlayer minecraft:diamond 1');
  assert.equal(state.audits[0].type, 'minecraft_shop_purchase');
});

test('an unsuccessful RCON result fails the purchase and restores the wallet with audit', async () => {
  const state = fakeDatabase(150);
  let calls = 0;

  const result = await purchaseMinecraftShopItem('guild-a', member, 'item', dependencies(state, {
    executeCommand: async () => {
      calls++;
      return { success: false, error: 'server offline' };
    },
  }));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'DELIVERY_FAILED');
  assert.equal(result.currentWallet, 150);
  assert.equal(state.wallet, 150);
  assert.equal(calls, 1);
  assert.deepEqual(
    state.audits.map((audit) => [audit.type, audit.amount, audit.targetId]),
    [
      ['minecraft_shop_purchase_failed', -100, 'item'],
      ['minecraft_shop_purchase_refund', 100, 'audit-1'],
    ]
  );
});

test('partial bundle delivery is audited without an exploitable full refund', async () => {
  const state = fakeDatabase(150);
  let calls = 0;

  const result = await purchaseMinecraftShopItem('guild-a', member, 'item', dependencies(state, {
    getShopItem: async () => item({
      rconCommand: [
        'give {username} minecraft:diamond 1',
        'give {username} minecraft:emerald 1',
      ].join('; '),
    }),
    executeCommand: async () => {
      calls++;
      return calls === 1
        ? { success: true }
        : { success: false, error: 'second delivery failed' };
    },
  }));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'DELIVERY_PARTIAL');
  assert.equal(result.currentWallet, 50);
  assert.equal(state.wallet, 50);
  assert.equal(calls, 2);
  assert.deepEqual(
    state.audits.map((audit) => [audit.type, audit.amount]),
    [['minecraft_shop_purchase_partial', -100]]
  );
  assert.match(state.audits[0].details, /delivered commands: 1\/2/);
});

test('two concurrent purchases cannot spend the same balance', async () => {
  const state = fakeDatabase(100);
  const deps = dependencies(state);

  const results = await Promise.all([
    purchaseMinecraftShopItem('guild-a', member, 'item', deps),
    purchaseMinecraftShopItem('guild-a', member, 'item', deps),
  ]);

  assert.equal(results.filter((result) => result.success).length, 1);
  assert.equal(
    results.filter((result) => result.reason === 'INSUFFICIENT_FUNDS').length,
    1
  );
  assert.equal(state.wallet, 0);
  assert.equal(state.audits.filter((audit) => audit.amount === -100).length, 1);
});

test('unsafe stored item is rejected before wallet or RCON access', async () => {
  const state = fakeDatabase(100);
  let rconCalls = 0;
  const result = await purchaseMinecraftShopItem('guild-a', member, 'item', dependencies(state, {
    getShopItem: async () => item({ priceShekels: -100 }),
    executeCommand: async () => {
      rconCalls++;
      return { success: true };
    },
  }));

  assert.equal(result.success, false);
  assert.equal(result.reason, 'INVALID_PRICE');
  assert.equal(state.wallet, 100);
  assert.equal(rconCalls, 0);
});

test('purchase failures explain refund and partial-delivery state to the user', () => {
  assert.match(
    buildMinecraftPurchaseFailureText({ reason: 'DELIVERY_FAILED', currentWallet: 150 }),
    /возвращены.*150/s,
  );
  assert.match(
    buildMinecraftPurchaseFailureText({ reason: 'DELIVERY_PARTIAL' }),
    /частично.*ручной сверки/s,
  );
  assert.match(
    buildMinecraftPurchaseFailureText({ reason: 'REFUND_PENDING' }),
    /возврат.*не подтверждён/s,
  );
});
