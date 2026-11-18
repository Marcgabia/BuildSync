const { pool } = require('../lib/db');

const types = {
  requisition_submitted: 'Requisition submitted',
  requisition_decision: 'Requisition decision',
  po_pending_approval: 'Purchase order awaiting approval',
  po_approved: 'Purchase order approved',
  po_decision: 'Purchase order decision',
  delivery_upcoming: 'Upcoming delivery',
  delivery_overdue: 'Overdue delivery',
  delivery_received: 'Delivery received',
  low_stock: 'Low-stock warning',
  budget_threshold: 'Budget threshold',
  account: 'Account and role changes'
};

async function notifyUser(connection, userId, payload) {
  if (!userId) return;
  const { type, title, message, link = null, referenceType = null, referenceId = null, dedupeKey = null } = payload;
  // INSERT IGNORE + unique (user_id, dedupe_key) prevents duplicate alerts.
  await (connection || pool()).execute(
    `INSERT IGNORE INTO notifications
      (user_id, type, title, message, link, reference_type, reference_id, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, String(title).slice(0, 200), String(message).slice(0, 1000), link,
      referenceType, referenceId, dedupeKey]
  );
}

/** Returns active users holding any of the given permissions via an active role. */
async function usersWithPermission(connection, permissionKeys) {
  const keys = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];
  const [rows] = await (connection || pool()).query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id AND r.is_active = 1
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.status = 'Active' AND p.permission_key IN (?)`,
    [keys]
  );
  return rows.map((row) => row.id);
}

async function notifyPermission(connection, permissionKeys, payload, { exceptUserId = null } = {}) {
  const userIds = await usersWithPermission(connection, permissionKeys);
  for (const userId of userIds) {
    if (exceptUserId && Number(userId) === Number(exceptUserId)) continue;
    await notifyUser(connection, userId, payload);
  }
}

async function unreadCount(userId) {
  const [rows] = await pool().execute(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  return Number(rows[0].total);
}

module.exports = { types, notifyUser, notifyPermission, usersWithPermission, unreadCount };
