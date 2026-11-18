const { pool } = require('../lib/db');
const { handle, paramId, paginate, notFound, safeRedirectPath } = require('../lib/http');
const notifications = require('../services/notifications');
const { action } = require('./helpers');

const index = handle(async (req, res) => {
  const type = Object.keys(notifications.types).includes(req.query.type) ? req.query.type : 'All';
  const readState = ['unread', 'read'].includes(req.query.state) ? req.query.state : 'all';
  const where = `WHERE user_id = ? AND (? = 'All' OR type = ?)
    AND (? = 'all' OR (? = 'unread' AND is_read = 0) OR (? = 'read' AND is_read = 1))`;
  const params = [req.user.id, type, type, readState, readState, readState];
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total FROM notifications ${where}`, params);
  const pageInfo = paginate(count.total, req.query.page, 20);
  const [rows] = await pool().execute(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageInfo.pageSize, pageInfo.offset]
  );
  res.render('notifications/index', { notifications: rows, types: notifications.types, filters: { type, state: readState }, pageInfo });
});

/** Marks a notification as read and opens the related record. */
const open = handle(async (req, res) => {
  const [rows] = await pool().execute('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [paramId(req), req.user.id]);
  const notification = rows[0];
  if (!notification) throw notFound();
  await pool().execute('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE id = ?', [notification.id]);
  res.redirect(safeRedirectPath(notification.link, '/notifications'));
});

const markRead = action(async (req) => {
  await pool().execute(
    'UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?',
    [paramId(req), req.user.id]
  );
}, { success: 'Notification marked as read.', redirect: '/notifications' });

const markAllRead = action(async (req) => {
  const [result] = await pool().execute(
    'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0', [req.user.id]
  );
  return { count: result.affectedRows };
}, { success: (result) => `${result.count} notification(s) marked as read.`, redirect: '/notifications' });

module.exports = { index, open, markRead, markAllRead };
