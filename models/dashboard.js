const { pool } = require('../lib/db');
const Budget = require('./budget');

const spendStatuses = "('Approved', 'Ordered', 'Partially Received', 'Completed')";

const Dashboard = {
  async stats() {
    const [[row]] = await pool().execute(
      `SELECT
        (SELECT COUNT(*) FROM suppliers WHERE status = 'Active') AS active_suppliers,
        (SELECT COUNT(*) FROM suppliers) AS total_suppliers,
        (SELECT COUNT(*) FROM products WHERE status = 'Active') AS total_products,
        (SELECT COUNT(*) FROM purchase_requisitions) AS total_requisitions,
        (SELECT COUNT(*) FROM purchase_orders) AS total_orders,
        (SELECT COUNT(*) FROM purchase_requisitions WHERE status IN ('Submitted', 'Under Review')) AS pending_requisitions,
        (SELECT COUNT(*) FROM purchase_orders WHERE status = 'Pending Approval') AS pending_orders,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('Ordered', 'Partially Received')) AS ongoing_deliveries,
        (SELECT COALESCE(SUM(total_cost), 0) FROM purchase_orders WHERE status IN ${spendStatuses}) AS total_expenses,
        (SELECT COALESCE(SUM(total_cost), 0) FROM purchase_orders WHERE status IN ('Draft', 'Pending Approval')) AS awaiting_value`
    );
    return { ...row, budget: await Budget.currentTotals() };
  },

  /** Approved-or-later order value per month for the last 12 months (zero-filled). */
  async monthlyExpenses(months = 12) {
    const [rows] = await pool().execute(
      `SELECT DATE_FORMAT(order_date, '%Y-%m') AS month, COALESCE(SUM(total_cost), 0) AS total
       FROM purchase_orders
       WHERE status IN ${spendStatuses}
         AND order_date >= DATE_FORMAT(CURDATE() - INTERVAL ? MONTH, '%Y-%m-01')
       GROUP BY month ORDER BY month`,
      [months - 1]
    );
    const byMonth = new Map(rows.map((r) => [r.month, Number(r.total)]));
    const result = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      result.push({
        month: key,
        label: d.toLocaleString('en-US', { month: 'short' }),
        year: d.getFullYear(),
        total: byMonth.get(key) || 0
      });
    }
    return result;
  },

  async orderStatusCounts() {
    const [rows] = await pool().execute('SELECT status, COUNT(*) AS total FROM purchase_orders GROUP BY status');
    return new Map(rows.map((row) => [row.status, Number(row.total)]));
  },

  async recentActivity(limit = 10) {
    const [rows] = await pool().execute(
      `SELECT * FROM (
         SELECT 'Requisition created' AS kind, r.requisition_number AS label, u.full_name AS actor,
                r.created_at AS at, CONCAT('/requisitions/', r.id) AS link
         FROM purchase_requisitions r JOIN users u ON u.id = r.requested_by
         UNION ALL
         SELECT 'Purchase order approved', po.po_number, u.full_name, po.approved_at, CONCAT('/purchase-orders/', po.id)
         FROM purchase_orders po LEFT JOIN users u ON u.id = po.approved_by WHERE po.approved_at IS NOT NULL
         UNION ALL
         SELECT 'Supplier added', s.vendor_name, NULL, s.created_at, CONCAT('/suppliers/', s.id)
         FROM suppliers s
         UNION ALL
         SELECT 'Delivery received', CONCAT(d.delivery_number, ' · ', po.po_number), u.full_name, d.confirmed_at,
                CONCAT('/deliveries/', d.id)
         FROM deliveries d JOIN purchase_orders po ON po.id = d.purchase_order_id
         LEFT JOIN users u ON u.id = d.received_by
         WHERE d.confirmed_at IS NOT NULL AND d.status <> 'Rejected'
       ) activity
       ORDER BY at DESC LIMIT ?`,
      [limit]
    );
    return rows;
  },

  async upcomingDeliveries(limit = 8) {
    const [rows] = await pool().execute(
      `SELECT po.id, po.po_number, po.status, po.target_date, po.total_cost, s.vendor_name,
              DATEDIFF(po.target_date, CURDATE()) AS days_left
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.status IN ('Approved', 'Ordered', 'Partially Received')
       ORDER BY po.target_date, po.id LIMIT ?`,
      [limit]
    );
    return rows;
  },

  async alerts(upcomingDays) {
    const [[counts]] = await pool().execute(
      `SELECT
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('Approved', 'Ordered', 'Partially Received')
           AND target_date < CURDATE()) AS overdue,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('Approved', 'Ordered', 'Partially Received')
           AND target_date BETWEEN CURDATE() AND CURDATE() + INTERVAL ? DAY) AS upcoming`,
      [upcomingDays]
    );
    const [lowStock] = await pool().execute(
      `SELECT id, name, product_code, current_stock, minimum_stock, unit FROM products
       WHERE status = 'Active' AND minimum_stock > 0 AND current_stock <= minimum_stock
       ORDER BY current_stock / minimum_stock, name LIMIT 6`
    );
    const budgets = (await Budget.list({ status: 'Active' }))
      .filter((b) => b.allocated_amount > 0 && b.utilization >= Number(b.warning_threshold));
    return { overdue: Number(counts.overdue), upcoming: Number(counts.upcoming), lowStock, budgets };
  }
};

module.exports = Dashboard;
