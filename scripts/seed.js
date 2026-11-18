const database = require('../database');
const { migrate } = require('../migrations/runner');
const { seed } = require('../seeders');

let connection;

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Refusing to load sample data in production. Set SEED_ALLOW_PRODUCTION=true to override.');
  }

  connection = await database.initializeDatabase();
  await migrate({ connection });
  const created = await seed();
  console.log(`Seed complete: ${created.suppliers} suppliers and ${created.purchaseOrders} purchase orders added.`);
}

main()
  .catch((error) => {
    console.error('Database seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        console.error('Database shutdown failed:', error);
        process.exitCode = 1;
      }
    }
  });
