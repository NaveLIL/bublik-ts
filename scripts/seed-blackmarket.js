const { PrismaClient } = require('@prisma/client');

async function main() {
  const adminId = '349212500702658571';
  const prisma = new PrismaClient();

  console.log('Fetching active guilds from economy configs...');
  const configs = await prisma.economyConfig.findMany({
    select: { guildId: true }
  });

  const guildIds = configs.map(c => c.guildId);
  console.log(`Found active guilds: ${guildIds.join(', ')}`);

  if (guildIds.length === 0) {
    console.error('No economy configs found in the database. Run /setup first!');
    await prisma.$disconnect();
    process.exit(1);
  }

  for (const guildId of guildIds) {
    console.log(`\nSeeding Black Market for guild: ${guildId}`);

    // Ensure admin profile exists in this guild
    await prisma.economyProfile.upsert({
      where: { guildId_userId: { guildId, userId: adminId } },
      create: { guildId, userId: adminId, wallet: 100000 },
      update: {}
    });

    // Clear old seeded listings for this admin in this guild to prevent duplicate spam
    await prisma.blackMarketListing.deleteMany({
      where: { guildId, sellerId: adminId }
    });

    const listings = [
      {
        guildId,
        sellerId: adminId,
        itemKey: 'mask',
        name: '🎭 Маска с Кармеля',
        type: 'mask',
        quantity: 10,
        price: 2000,
        description: 'Скрывает лицо при ограблениях/преступлениях. Спасает от розыска.',
        perks: {},
        isCustom: false
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'lockpick',
        name: '🔒 Отмычка',
        type: 'lockpick',
        quantity: 15,
        price: 1500,
        description: 'Используется для взлома. Повышает шанс успеха /rob на 20%.',
        perks: {},
        isCustom: false
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'safe',
        name: '💼 Сейф',
        type: 'safe',
        quantity: 5,
        price: 8000,
        description: 'Защищает накопления в банке от воров при активации через инвентарь.',
        perks: {},
        isCustom: false
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'custom_shotgun',
        name: '🔫 Дробовик Синдиката',
        type: 'custom',
        quantity: 2,
        price: 15000,
        description: 'Тяжелый обрез. Дает пассивный бонус +15% к успешности криминала (/crime).',
        perks: { crimeBonus: 15 },
        isCustom: true
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'custom_nvg',
        name: '🕶️ Очки ночного видения',
        type: 'custom',
        quantity: 2,
        price: 12000,
        description: 'Облегчают скрытный отход. Ускоряют сгорание звезд розыска на 30% (x0.7).',
        perks: { wantedDecayMul: 0.7 },
        isCustom: true
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'custom_fake_pass',
        name: '🪪 Фальшивый паспорт',
        type: 'custom',
        quantity: 2,
        price: 18000,
        description: 'Уменьшает шанс получить звезду розыска на 40% (x0.6) при кражах.',
        perks: { wantedChanceMul: 0.6 },
        isCustom: true
      },
      {
        guildId,
        sellerId: adminId,
        itemKey: 'custom_brass',
        name: '👊 Кастет "Шалом"',
        type: 'custom',
        quantity: 5,
        price: 5000,
        description: 'Латунный кастет. Дает пассивный бонус +5% к успешности ограблений (/rob).',
        perks: { robBonus: 5 },
        isCustom: true
      }
    ];

    await prisma.blackMarketListing.createMany({
      data: listings
    });

    console.log(`Successfully seeded ${listings.length} listings in guild ${guildId}`);
  }

  await prisma.$disconnect();
  console.log('\nSeeding completed!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
