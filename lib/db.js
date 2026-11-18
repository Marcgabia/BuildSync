const database = require('../database');

/**
 * Runs `work(connection)` inside a MySQL transaction on a dedicated pooled
 * connection. Commits when `work` resolves, rolls back when it throws.
 */
async function withTransaction(work) {
  const connection = await database.getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }
}

function pool() {
  return database.getPool();
}

module.exports = { withTransaction, pool };
