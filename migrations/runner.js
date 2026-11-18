const fs = require('node:fs');
const path = require('node:path');
const database = require('../database');

const migrationsDirectory = __dirname;

async function ensureMigrationTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration VARCHAR(191) NOT NULL PRIMARY KEY,
      batch INT NOT NULL,
      ran_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function listMigrations() {
  return fs.readdirSync(migrationsDirectory)
    .filter((file) => /^\d+_.+\.(js|sql)$/.test(file))
    .sort()
    .map((file) => ({ name: file, path: path.join(migrationsDirectory, file) }));
}

/**
 * Splits a reviewed .sql migration into statements. Full-line `--` comments are
 * removed and statements end with a semicolon at the end of a line. Migration
 * files must not contain semicolons at line ends inside string literals.
 */
function splitSqlStatements(sql) {
  const lines = sql.replace(/\r\n/g, '\n').split('\n')
    .filter((line) => !/^\s*--/.test(line));
  const statements = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (/;\s*$/.test(line)) {
      const statement = current.join('\n').trim().replace(/;\s*$/, '').trim();
      if (statement) statements.push(statement);
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest) statements.push(rest);
  return statements;
}

async function runSqlMigration(connection, filePath) {
  const statements = splitSqlStatements(fs.readFileSync(filePath, 'utf8'));
  for (const statement of statements) {
    await connection.query(statement);
  }
}

async function getPendingMigrations(connection, migrations = listMigrations()) {
  const [rows] = await connection.query('SELECT migration FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.migration));
  return migrations.filter((migration) => !applied.has(migration.name));
}

async function migrate({ connection, logger = console } = {}) {
  const activeConnection = connection || await database.initializeDatabase();
  await ensureMigrationTable(activeConnection);

  const pending = await getPendingMigrations(activeConnection);
  if (!pending.length) {
    logger.log('Database is already up to date.');
    return [];
  }

  const [[batchRow]] = await activeConnection.query(
    'SELECT COALESCE(MAX(batch), 0) AS current_batch FROM schema_migrations'
  );
  const batch = Number(batchRow.current_batch || 0) + 1;
  const completed = [];

  for (const migration of pending) {
    if (migration.name.endsWith('.sql')) {
      await runSqlMigration(activeConnection, migration.path);
    } else {
      const { up } = require(migration.path);
      if (typeof up !== 'function') {
        throw new TypeError(`Migration ${migration.name} must export an up function.`);
      }
      await up(activeConnection);
    }
    await activeConnection.execute(
      'INSERT INTO schema_migrations (migration, batch) VALUES (?, ?)',
      [migration.name, batch]
    );
    completed.push(migration.name);
    logger.log(`Migrated: ${migration.name}`);
  }

  return completed;
}

module.exports = { migrate, listMigrations, getPendingMigrations, splitSqlStatements };
