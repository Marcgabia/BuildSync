const mysql = require('mysql2/promise');

const state = {
  pool: null,
  initializing: null
};

const config = {
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 3306),
  user: process.env.DATABASE_USER || 'root',
  password: process.env.DATABASE_PASSWORD || '',
  database: process.env.DATABASE_NAME || 'buildsync_db',
  waitForConnections: true,
  connectionLimit: Number(process.env.DATABASE_CONNECTION_LIMIT || 10),
  connectTimeout: Number(process.env.DATABASE_CONNECT_TIMEOUT || 5000),
  decimalNumbers: true,
  dateStrings: true
};

async function initializeDatabase() {
  if (state.pool) return state.pool;
  if (state.initializing) return state.initializing;

  state.initializing = (async () => {
    const pool = mysql.createPool(config);
    try {
      await pool.query('SELECT 1');
      state.pool = pool;
      console.log(`Connected to MySQL database "${config.database}".`);
      return pool;
    } catch (error) {
      await pool.end();
      throw new Error(
        `Could not connect to MySQL database "${config.database}" at ${config.host}:${config.port}. ` +
        'Check the MySQL service and DATABASE_* settings.',
        { cause: error }
      );
    }
  })();

  try {
    return await state.initializing;
  } finally {
    state.initializing = null;
  }
}

function getPool() {
  if (!state.pool) {
    throw new Error('MySQL has not been initialized yet.');
  }
  return state.pool;
}

module.exports = { initializeDatabase, getPool };
