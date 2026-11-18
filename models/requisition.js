const { pool } = require('../lib/db');

const filters = `
  WHERE (? = 0 OR r.requested_by = ?)
    AND (? = '' OR r.requisition_number LIKE ? OR r.purpose LIKE ? OR u.full_name LIKE ?)
    AND (? = 'All' OR r.status = ?)
    AND (? = 0 OR r.department_id = ?)
    AND (? IS NULL OR r.request_date >= ?)
    AND (? IS NULL OR r.request_date <= ?)`;

function values({ ownerId = 0, search = '', status = 'All', departmentId = 0, from = '', to = '' }) {
  const like = `%${search}%`;
  return [ownerId, ownerId, search, like, like, like, status, status, departmentId, departmentId, from || null, from || null, to || null, to || null];
}

const Requisition = {
  async list(options = {}) {
    const params = values(options);
    const paginate = Number.isInteger(options.limit);
    if (paginate) params.push(options.limit, options.offset || 0);
    const [rows] = await pool().execute(
      `SELECT r.*, u.full_name AS requester_name, d.name AS department_name,
              (SELECT COUNT(*) FROM requisition_items i WHERE i.requisition_id = r.id) AS item_count,
              (SELECT po.id FROM purchase_orders po WHERE po.active_requisition_id = r.id) AS purchase_order_id
       FROM purchase_requisitions r
       JOIN users u ON u.id = r.requested_by
       JOIN departments d ON d.id = r.department_id
       ${filters}
       ORDER BY r.created_at DESC, r.id DESC${paginate ? ' LIMIT ? OFFSET ?' : ''}`,
      params
    );
    return rows;
  },

  async count(options = {}) {
    const [rows] = await pool().execute(
      `SELECT COUNT(*) AS total FROM purchase_requisitions r JOIN users u ON u.id = r.requested_by ${filters}`,
      values(options)
    );
    return Number(rows[0].total);
  },

  async findById(id) {
    const [rows] = await pool().execute(
      `SELECT r.*, u.full_name AS requester_name, u.email AS requester_email, d.name AS department_name
       FROM purchase_requisitions r
       JOIN users u ON u.id = r.requested_by
       JOIN departments d ON d.id = r.department_id
       WHERE r.id = ?`,
      [id]
    );
    const record = rows[0];
    if (!record) return null;
    const [items] = await pool().execute(
      `SELECT i.*, p.name AS product_name, p.product_code, p.unit, p.supplier_id, p.current_stock
       FROM requisition_items i JOIN products p ON p.id = i.product_id
       WHERE i.requisition_id = ? ORDER BY i.line_no`,
      [id]
    );
    const [orders] = await pool().execute(
      'SELECT id, po_number, status, total_cost FROM purchase_orders WHERE requisition_id = ? ORDER BY id DESC', [id]
    );
    return { ...record, items, orders };
  },

  async approvedForConversion() {
    const [rows] = await pool().execute(
      `SELECT r.id, r.requisition_number, r.total_estimated, d.name AS department_name
       FROM purchase_requisitions r JOIN departments d ON d.id = r.department_id
       WHERE r.status = 'Approved' ORDER BY r.decided_at, r.id`
    );
    return rows;
  },

  async statusCounts({ from = '', to = '' } = {}) {
    const [rows] = await pool().execute(
      `SELECT status, COUNT(*) AS total, COALESCE(SUM(total_estimated), 0) AS amount
       FROM purchase_requisitions
       WHERE (? IS NULL OR request_date >= ?) AND (? IS NULL OR request_date <= ?)
       GROUP BY status`,
      [from || null, from || null, to || null, to || null]
    );
    return rows;
  }
};

module.exports = Requisition;
