const { pool } = require('../lib/db');

const filters = `
  WHERE (? = '' OR p.name LIKE ? OR p.product_code LIKE ? OR p.description LIKE ?)
    AND (? = 0 OR p.category_id = ?)
    AND (? = 'All' OR p.status = ?)
    AND (? = 0 OR p.current_stock <= p.minimum_stock)`;

function values({ search = '', categoryId = 0, status = 'All', lowStock = false }) {
  const like = `%${search}%`;
  const low = lowStock ? 1 : 0;
  return [search, like, like, like, categoryId, categoryId, status, status, low];
}

const Product = {
  async list(options = {}) {
    const params = values(options);
    const paginate = Number.isInteger(options.limit);
    if (paginate) params.push(options.limit, options.offset || 0);
    const [rows] = await pool().execute(
      `SELECT p.*, c.name AS category_name, s.vendor_name AS supplier_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${filters}
       ORDER BY p.name, p.id${paginate ? ' LIMIT ? OFFSET ?' : ''}`,
      params
    );
    return rows;
  },

  async count(options = {}) {
    const [rows] = await pool().execute(`SELECT COUNT(*) AS total FROM products p ${filters}`, values(options));
    return Number(rows[0].total);
  },

  async active() {
    const [rows] = await pool().execute(
      `SELECT p.id, p.product_code, p.name, p.unit, p.unit_price, p.supplier_id, p.current_stock
       FROM products p WHERE p.status = 'Active' ORDER BY p.name`
    );
    return rows;
  },

  async findById(id) {
    const [rows] = await pool().execute(
      `SELECT p.*, c.name AS category_name, s.vendor_name AS supplier_name, u.full_name AS created_by_name
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async movements(productId, limit = 50) {
    const [rows] = await pool().execute(
      `SELECT t.*, u.full_name AS user_name FROM inventory_transactions t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.product_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      [productId, limit]
    );
    return rows;
  },

  async dependencyCount(id) {
    const [[row]] = await pool().execute(
      `SELECT (SELECT COUNT(*) FROM requisition_items WHERE product_id = ?)
            + (SELECT COUNT(*) FROM purchase_order_items WHERE product_id = ?)
            + (SELECT COUNT(*) FROM delivery_items WHERE product_id = ?)
            + (SELECT COUNT(*) FROM inventory_transactions WHERE product_id = ? AND transaction_type <> 'Opening') AS total`,
      [id, id, id, id]
    );
    return Number(row.total);
  },

  async counts() {
    const [[row]] = await pool().execute(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'Active'), 0) AS active,
              COALESCE(SUM(status = 'Active' AND minimum_stock > 0 AND current_stock <= minimum_stock), 0) AS low_stock,
              COALESCE(SUM(current_stock * unit_price), 0) AS stock_value
       FROM products`
    );
    return row;
  }
};

const Category = {
  async list({ search = '' } = {}) {
    const [rows] = await pool().execute(
      `SELECT c.*, COUNT(p.id) AS product_count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       WHERE (? = '' OR c.name LIKE ?)
       GROUP BY c.id ORDER BY c.name`,
      [search, `%${search}%`]
    );
    return rows;
  },

  async active() {
    const [rows] = await pool().execute('SELECT id, name FROM categories WHERE is_active = 1 ORDER BY name');
    return rows;
  },

  async findById(id) {
    const [rows] = await pool().execute('SELECT * FROM categories WHERE id = ?', [id]);
    return rows[0] || null;
  }
};

module.exports = { Product, Category };
