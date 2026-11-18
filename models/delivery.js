const { pool } = require('../lib/db');

const filters = `
  WHERE (? = '' OR d.delivery_number LIKE ? OR d.reference_number LIKE ? OR po.po_number LIKE ? OR s.vendor_name LIKE ?)
    AND (? = 'All' OR d.status = ?)
    AND (? IS NULL OR COALESCE(d.delivery_date, d.expected_date) >= ?)
    AND (? IS NULL OR COALESCE(d.delivery_date, d.expected_date) <= ?)`;

function values({ search = '', status = 'All', from = '', to = '' }) {
  const like = `%${search}%`;
  return [search, like, like, like, like, status, status, from || null, from || null, to || null, to || null];
}

const Delivery = {
  async list(options = {}) {
    const params = values(options);
    const paginate = Number.isInteger(options.limit);
    if (paginate) params.push(options.limit, options.offset || 0);
    const [rows] = await pool().execute(
      `SELECT d.*, po.po_number, s.vendor_name, u.full_name AS received_by_name,
              (SELECT COALESCE(SUM(accepted_quantity), 0) FROM delivery_items di WHERE di.delivery_id = d.id) AS accepted_total,
              (SELECT COALESCE(SUM(damaged_quantity), 0) FROM delivery_items di WHERE di.delivery_id = d.id) AS damaged_total
       FROM deliveries d
       JOIN purchase_orders po ON po.id = d.purchase_order_id
       JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN users u ON u.id = d.received_by
       ${filters}
       ORDER BY d.created_at DESC, d.id DESC${paginate ? ' LIMIT ? OFFSET ?' : ''}`,
      params
    );
    return rows;
  },

  async count(options = {}) {
    const [rows] = await pool().execute(
      `SELECT COUNT(*) AS total FROM deliveries d
       JOIN purchase_orders po ON po.id = d.purchase_order_id
       JOIN suppliers s ON s.id = d.supplier_id ${filters}`,
      values(options)
    );
    return Number(rows[0].total);
  },

  async findById(id) {
    const [rows] = await pool().execute(
      `SELECT d.*, po.po_number, po.status AS po_status, po.target_date, s.vendor_name, s.supplier_code,
              ru.full_name AS received_by_name, cu.full_name AS created_by_name
       FROM deliveries d
       JOIN purchase_orders po ON po.id = d.purchase_order_id
       JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN users ru ON ru.id = d.received_by
       LEFT JOIN users cu ON cu.id = d.created_by
       WHERE d.id = ?`,
      [id]
    );
    const delivery = rows[0];
    if (!delivery) return null;
    const [items] = await pool().execute(
      `SELECT di.*, i.item_code, i.description, i.line_no, p.unit FROM delivery_items di
       JOIN purchase_order_items i ON i.id = di.purchase_order_item_id
       LEFT JOIN products p ON p.id = di.product_id
       WHERE di.delivery_id = ? ORDER BY i.line_no`,
      [id]
    );
    const [attachments] = await pool().execute(
      `SELECT a.*, u.full_name AS uploaded_by_name FROM delivery_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.delivery_id = ? ORDER BY a.created_at`,
      [id]
    );
    return { ...delivery, items, attachments };
  },

  /** Order lines with remaining quantities, for the receiving form. */
  async orderLines(orderId) {
    const [rows] = await pool().execute(
      `SELECT i.*, (i.quantity - i.received_quantity) AS remaining_quantity, p.unit
       FROM purchase_order_items i LEFT JOIN products p ON p.id = i.product_id
       WHERE i.purchase_order_id = ? ORDER BY i.line_no`,
      [orderId]
    );
    return rows;
  },

  async receivableOrders() {
    const [rows] = await pool().execute(
      `SELECT po.id, po.po_number, po.status, po.target_date, s.vendor_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.status IN ('Approved', 'Ordered', 'Partially Received')
       ORDER BY po.target_date, po.id`
    );
    return rows;
  }
};

module.exports = Delivery;
