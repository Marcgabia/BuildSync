const database = require('../database');
const { migrate } = require('../migrations/runner');

let connection;

async function main() {
  connection = await database.initializeDatabase();
  await migrate({ connection });
}

main()
  .catch((error) => {
    console.error('Database migration failed:', error);
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
