const { pool } = require('../lib/db');
const v = require('../lib/validate');
const { handle, paginate, sendCsv } = require('../lib/http');

function readFilters(query) {
  return {
    search: String(query.q || '').trim().slice(0, 100),
    module: String(query.module || 'All').slice(0, 60),
    userId: v.isValidId(query.user) ? Number(query.user) : 0,
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : ''
  };
}

const where = `WHERE (? = '' OR l.description LIKE ? OR l.action LIKE ? OR l.record_id = ?)
  AND (? = 'All' OR l.module = ?) AND (? = 0 OR l.user_id = ?)
  AND (? IS NULL OR DATE(l.created_at) >= ?) AND (? IS NULL OR DATE(l.created_at) <= ?)`;

function params(f) {
  return [f.search, `%${f.search}%`, `%${f.search}%`, f.search, f.module, f.module, f.userId, f.userId, f.from || null, f.from || null, f.to || null, f.to || null];
}

/** Read-only audit trail. No route exists to modify or delete log entries. */
const index = handle(async (req, res) => {
  const filters = readFilters(req.query);
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total FROM activity_logs l ${where}`, params(filters));
  const pageInfo = paginate(count.total, req.query.page, 25);
  const [logs] = await pool().execute(
    `SELECT l.*, u.full_name AS user_name FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${where}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
    [...params(filters), pageInfo.pageSize, pageInfo.offset]
  );
  const [modules] = await pool().execute('SELECT DISTINCT module FROM activity_logs ORDER BY module');
  const [users] = await pool().execute('SELECT id, full_name FROM users ORDER BY full_name');
  res.render('activity-logs/index', { logs, filters, pageInfo, modules: modules.map((m) => m.module), users });
});

const exportCsv = handle(async (req, res) => {
  const filters = readFilters(req.query);
  const [logs] = await pool().execute(
    `SELECT l.*, u.full_name AS user_name FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${where}
     ORDER BY l.created_at DESC, l.id DESC LIMIT 10000`,
    params(filters)
  );
  sendCsv(res, 'activity-logs.csv', [
    { label: 'Log ID', key: 'id' }, { label: 'Timestamp', key: 'created_at' }, { label: 'User', key: 'user_name' },
    { label: 'Module', key: 'module' }, { label: 'Action', key: 'action' }, { label: 'Record ID', key: 'record_id' },
    { label: 'Description', key: 'description' }, { label: 'IP address', key: 'ip_address' }
  ], logs);
});

module.exports = { index, exportCsv };
