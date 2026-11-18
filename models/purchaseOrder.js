const database = require('../database');

const listFilters = `
  WHERE (? = '' OR po.po_number LIKE ? OR s.vendor_name LIKE ? OR s.supplier_code LIKE ?)
    AND (? = 'All' OR po.status = ?)
    AND (? = 0 OR po.supplier_id = ?)
    AND (? IS NULL OR po.order_date >= ?)
    AND (? IS NULL OR po.order_date <= ?)`;

function filterValues({ search = '', status = 'All', supplierId = 0, from = '', to = '' }) {
  const like = `%${search}%`;
  return [search, like, like, like, status, status, supplierId, supplierId, from || null, from || null, to || null, to || null];
}

class PurchaseOrder {
  constructor(connectionProvider = database.getPool) {
    this.connectionProvider = connectionProvider;
  }

  /** Lists orders. Without arguments returns every order (legacy behavior). */
  async all(filters = {}) {
    const pagination = Number.isInteger(filters.limit) && filters.limit > 0;
    const values = filterValues(filters);
    if (pagination) values.push(filters.limit, filters.offset || 0);
    const [rows] = await this.connectionProvider().execute(
      `SELECT po.*, s.vendor_name, s.supplier_code, d.name AS department_name,
              pr.requisition_number,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS line_count
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN departments d ON d.id = po.department_id
       LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
       ${listFilters}
       ORDER BY po.created_at DESC, po.id DESC${pagination ? ' LIMIT ? OFFSET ?' : ''}`,
      values
    );
    return rows;
  }

  async count(filters = {}) {
    const [rows] = await this.connectionProvider().execute(
      `SELECT COUNT(*) AS total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${listFilters}`,
      filterValues(filters)
    );
    return Number(rows[0].total);
  }

  async findById(id) {
    const [rows] = await this.connectionProvider().execute(
      'SELECT * FROM purchase_orders WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  async findByNumber(poNumber) {
    const [rows] = await this.connectionProvider().execute(
      'SELECT * FROM purchase_orders WHERE po_number = ?',
      [poNumber]
    );
    return rows[0] || null;
  }

  /** Full order with supplier, people, items, deliveries, and requisition. */
  async findDetail(id) {
    const [rows] = await this.connectionProvider().execute(
      `SELECT po.*, s.vendor_name, s.supplier_code, s.key_account_manager, s.email AS supplier_email,
              s.contact_number AS supplier_phone, s.warehouse_address AS supplier_address, s.tax_id AS supplier_tax_id,
              s.credit_terms, d.name AS department_name, cu.full_name AS created_by_name,
              au.full_name AS approved_by_name, pr.requisition_number, b.name AS budget_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN departments d ON d.id = po.department_id
       LEFT JOIN users cu ON cu.id = po.created_by
       LEFT JOIN users au ON au.id = po.approved_by
       LEFT JOIN purchase_requisitions pr ON pr.id = po.requisition_id
       LEFT JOIN budgets b ON b.id = po.budget_id
       WHERE po.id = ?`,
      [id]
    );
    const order = rows[0];
    if (!order) return null;
    const [items] = await this.connectionProvider().execute(
      `SELECT i.*, p.name AS product_name, p.unit FROM purchase_order_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.purchase_order_id = ? ORDER BY i.line_no`,
      [id]
    );
    const [deliveries] = await this.connectionProvider().execute(
      `SELECT d.*, u.full_name AS received_by_name FROM deliveries d
       LEFT JOIN users u ON u.id = d.received_by
       WHERE d.purchase_order_id = ? ORDER BY d.created_at DESC, d.id DESC`,
      [id]
    );
    return { ...order, items, deliveries };
  }

  /** Legacy single-item creation; also stores the line in purchase_order_items. */
  async create(attributes) {
    const pool = this.connectionProvider();
    const [result] = await pool.execute(
      `INSERT INTO purchase_orders
        (po_number, supplier_id, item_sku, description, quantity_ordered,
         unit_cost, subtotal, total_cost, status, target_date, order_date, created_by, department_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?)`,
      [
        attributes.po_number,
        attributes.supplier_id,
        attributes.item_sku,
        attributes.description,
        attributes.quantity_ordered,
        attributes.unit_cost,
        attributes.total_cost,
        attributes.total_cost,
        attributes.status || 'Pending Approval',
        attributes.target_date,
        attributes.created_by || null,
        attributes.department_id || null
      ]
    );
    const id = result.insertId || result.lastID;
    await pool.execute(
      `INSERT INTO purchase_order_items
        (purchase_order_id, line_no, item_code, description, quantity, unit_price, line_total, received_quantity)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      [id, attributes.item_sku, attributes.description, attributes.quantity_ordered, attributes.unit_cost,
        attributes.total_cost, attributes.status === 'Completed' ? attributes.quantity_ordered : 0]
    );
    if (attributes.status && attributes.status !== 'Draft') {
      await pool.execute('UPDATE purchase_orders SET submitted_at = NOW() WHERE id = ?', [id]);
    }
    return this.findById(id);
  }

  async updateStatus(id, status) {
    await this.connectionProvider().execute(
      'UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    return this.findById(id);
  }

  async activeSuppliers() {
    const [rows] = await this.connectionProvider().execute(
      `SELECT id, supplier_code, vendor_name
       FROM suppliers
       WHERE status = 'Active'
       ORDER BY vendor_name`
    );
    return rows;
  }

  async counts() {
    const [rows] = await this.connectionProvider().execute(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status IN ('Draft', 'Pending Approval') THEN total_cost ELSE 0 END), 0) AS awaiting_approval,
        COALESCE(SUM(CASE WHEN status <> 'Cancelled' THEN total_cost ELSE 0 END), 0) AS committed
       FROM purchase_orders`
    );
    return rows[0];
  }

  async recent(limit = 5) {
    const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 5)));
    const [rows] = await this.connectionProvider().execute(
      `SELECT po.id, po.po_number, po.status, po.total_cost, po.target_date, s.vendor_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC, po.id DESC
       LIMIT ?`,
      [safeLimit]
    );
    return rows;
  }
}

module.exports = PurchaseOrder;
