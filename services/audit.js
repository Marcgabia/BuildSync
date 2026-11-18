const { pool } = require('../lib/db');

/**
 * Appends an entry to the activity log. Pass the transaction connection when the
 * action is part of a transaction so the log commits or rolls back with it.
 * `actor` is either the Express request or `{ userId, ip }`.
 */
async function log(connection, actor, { action, module, recordId = null, description }) {
  const userId = actor && (actor.user ? actor.user.id : actor.userId) || null;
  const ip = actor && (actor.ip || null);
  await (connection || pool()).execute(
    `INSERT INTO activity_logs (user_id, action, module, record_id, description, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, String(action).slice(0, 60), String(module).slice(0, 60),
      recordId === null ? null : String(recordId).slice(0, 64),
      String(description).slice(0, 1000), ip ? String(ip).slice(0, 45) : null]
  );
}

module.exports = { log };
