const database = require('../database');

const supplierFields = [
  'supplier_code',
  'vendor_name',
  'key_account_manager',
  'contact_number',
  'email',
  'warehouse_address',
  'material_category',
  'credit_terms',
  'delivery_lead_time'
];

class Supplier {
  constructor(connectionProvider = database.getPool) {
    this.connectionProvider = connectionProvider;
  }

  async all({ search = '', status = 'All', limit, offset = 0 } = {}) {
    const pagination = Number.isInteger(limit) && limit > 0;
    const sql = `SELECT * FROM suppliers
       WHERE (? = '' OR supplier_code LIKE ? OR vendor_name LIKE ? OR material_category LIKE ?)
         AND (? = 'All' OR status = ?)
       ORDER BY vendor_name, id${pagination ? '\n       LIMIT ? OFFSET ?' : ''}`;
    const values = [search, `%${search}%`, `%${search}%`, `%${search}%`, status, status];
    if (pagination) values.push(limit, offset);
    const [rows] = await this.connectionProvider().execute(sql, values);
    return rows;
  }

  async count({ search = '', status = 'All' } = {}) {
    const [rows] = await this.connectionProvider().execute(
      `SELECT COUNT(*) AS total FROM suppliers
       WHERE (? = '' OR supplier_code LIKE ? OR vendor_name LIKE ? OR material_category LIKE ?)
         AND (? = 'All' OR status = ?)`,
      [search, `%${search}%`, `%${search}%`, `%${search}%`, status, status]
    );
    return Number(rows[0].total);
  }

  async findById(id) {
    const [rows] = await this.connectionProvider().execute(
      'SELECT * FROM suppliers WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  async findWithPurchaseHistory(id) {
    const supplier = await this.findById(id);
    if (!supplier) return null;
    const [orders] = await this.connectionProvider().execute(
      `SELECT po.id, po.po_number, po.status, po.total_cost, po.target_date, po.order_date, po.created_at,
              COALESCE(po.item_sku, (SELECT GROUP_CONCAT(i.item_code ORDER BY i.line_no SEPARATOR ', ')
                FROM purchase_order_items i WHERE i.purchase_order_id = po.id)) AS item_sku,
              COALESCE(po.description, (SELECT CONCAT(COUNT(*), ' line item(s)')
                FROM purchase_order_items i WHERE i.purchase_order_id = po.id)) AS description,
              po.quantity_ordered, po.unit_cost
       FROM purchase_orders po
       WHERE po.supplier_id = ?
       ORDER BY po.created_at DESC, po.id DESC`,
      [id]
    );
    return { ...supplier, purchaseOrders: orders, performance: await this.performance(id) };
  }

  /**
   * Supplier performance on a 5-point scale:
   * - Delivery timeliness: share of confirmed deliveries received on/before the expected date.
   * - Product quality: accepted quantity / received quantity.
   * - Service reliability: the evaluator's rating (1–5) recorded on the supplier profile.
   */
  async performance(id) {
    const [[timeliness]] = await this.connectionProvider().execute(
      `SELECT COUNT(*) AS deliveries,
              COALESCE(SUM(d.delivery_date <= COALESCE(d.expected_date, po.target_date)), 0) AS on_time
       FROM deliveries d JOIN purchase_orders po ON po.id = d.purchase_order_id
       WHERE d.supplier_id = ? AND d.confirmed_at IS NOT NULL AND d.delivery_date IS NOT NULL`,
      [id]
    );
    const [[quality]] = await this.connectionProvider().execute(
      `SELECT COALESCE(SUM(di.received_quantity), 0) AS received, COALESCE(SUM(di.accepted_quantity), 0) AS accepted
       FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE d.supplier_id = ?`,
      [id]
    );
    const [[supplier]] = await this.connectionProvider().execute(
      'SELECT reliability_rating FROM suppliers WHERE id = ?', [id]
    );
    const deliveries = Number(timeliness.deliveries);
    const received = Number(quality.received);
    const scores = {
      timeliness: deliveries ? (Number(timeliness.on_time) / deliveries) * 5 : null,
      quality: received ? (Number(quality.accepted) / received) * 5 : null,
      reliability: supplier && supplier.reliability_rating ? Number(supplier.reliability_rating) : null
    };
    const available = Object.values(scores).filter((value) => value !== null);
    return {
      ...scores,
      overall: available.length ? available.reduce((a, b) => a + b, 0) / available.length : null,
      deliveries,
      onTime: Number(timeliness.on_time),
      received,
      accepted: Number(quality.accepted)
    };
  }

  async findByCode(code) {
    const [rows] = await this.connectionProvider().execute(
      'SELECT * FROM suppliers WHERE supplier_code = ?',
      [code]
    );
    return rows[0] || null;
  }

  async findActiveById(id) {
    const [rows] = await this.connectionProvider().execute(
      "SELECT * FROM suppliers WHERE id = ? AND status = 'Active'",
      [id]
    );
    return rows[0] || null;
  }

  async create(attributes) {
    const values = supplierFields.map((field) => attributes[field]);
    const [result] = await this.connectionProvider().execute(
      `INSERT INTO suppliers
        (supplier_code, vendor_name, key_account_manager, contact_number, email,
         warehouse_address, material_category, credit_terms, delivery_lead_time, status,
         tax_id, reliability_rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, attributes.status || 'Active', attributes.tax_id || null, attributes.reliability_rating || null]
    );
    return this.findById(result.insertId || result.lastID);
  }

  async update(id, attributes) {
    const values = supplierFields.map((field) => attributes[field]);
    await this.connectionProvider().execute(
      `UPDATE suppliers
       SET supplier_code = ?, vendor_name = ?, key_account_manager = ?, contact_number = ?,
           email = ?, warehouse_address = ?, material_category = ?, credit_terms = ?,
           delivery_lead_time = ?, status = ?, tax_id = ?, reliability_rating = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [...values, attributes.status, attributes.tax_id || null, attributes.reliability_rating || null, id]
    );
    return this.findById(id);
  }

  async updateStatus(id, status) {
    await this.connectionProvider().execute(
      'UPDATE suppliers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    return this.findById(id);
  }

  /** Number of transaction/catalog records that reference the supplier. */
  async dependencyCount(id) {
    const [[row]] = await this.connectionProvider().execute(
      `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = ?)
            + (SELECT COUNT(*) FROM products WHERE supplier_id = ?)
            + (SELECT COUNT(*) FROM deliveries WHERE supplier_id = ?) AS total`,
      [id, id, id]
    );
    return Number(row.total);
  }

  async remove(id) {
    const [result] = await this.connectionProvider().execute('DELETE FROM suppliers WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async counts() {
    const [rows] = await this.connectionProvider().execute(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'Active'), 0) AS active
       FROM suppliers`
    );
    return rows[0];
  }
}

module.exports = Supplier;
