const { pool } = require('../lib/db');
const { balanceSelect, withDerived } = require('../services/budget');

const Budget = {
  async list({ departmentId = 0, year = 0, status = 'All' } = {}) {
    const [rows] = await pool().execute(
      `${balanceSelect}
       WHERE (? = 0 OR b.department_id = ?) AND (? = 0 OR b.fiscal_year = ?) AND (? = 'All' OR b.status = ?)
       GROUP BY b.id
       ORDER BY b.fiscal_year DESC, b.period_month DESC, d.name`,
      [departmentId, departmentId, year, year, status, status]
    );
    return rows.map(withDerived);
  },

  async findById(id) {
    const [rows] = await pool().execute(`${balanceSelect} WHERE b.id = ? GROUP BY b.id`, [id]);
    return withDerived(rows[0]);
  },

  async transactions(budgetId) {
    const [rows] = await pool().execute(
      `SELECT bt.*, po.po_number, dl.delivery_number, u.full_name AS user_name
       FROM budget_transactions bt
       LEFT JOIN purchase_orders po ON po.id = bt.purchase_order_id
       LEFT JOIN deliveries dl ON dl.id = bt.delivery_id
       LEFT JOIN users u ON u.id = bt.created_by
       WHERE bt.budget_id = ? ORDER BY bt.created_at DESC, bt.id DESC`,
      [budgetId]
    );
    return rows;
  },

  async years() {
    const [rows] = await pool().execute('SELECT DISTINCT fiscal_year FROM budgets ORDER BY fiscal_year DESC');
    return rows.map((row) => row.fiscal_year);
  },

  /** Totals for active budgets covering today (dashboard). */
  async currentTotals() {
    const [rows] = await pool().execute(
      `${balanceSelect}
       WHERE b.status = 'Active' AND CURDATE() BETWEEN b.period_start AND b.period_end
         AND NOT (b.period_type = 'Annual' AND EXISTS (
           SELECT 1 FROM budgets m WHERE m.department_id = b.department_id AND m.period_type = 'Monthly'
             AND m.status = 'Active' AND CURDATE() BETWEEN m.period_start AND m.period_end))
       GROUP BY b.id`
    );
    const budgets = rows.map(withDerived);
    return budgets.reduce((sum, b) => ({
      allocated: sum.allocated + b.allocated_amount,
      committed: sum.committed + b.committed_amount,
      actual: sum.actual + b.actual_amount,
      remaining: sum.remaining + b.remaining_amount,
      count: sum.count + 1
    }), { allocated: 0, committed: 0, actual: 0, remaining: 0, count: 0 });
  }
};

module.exports = Budget;
