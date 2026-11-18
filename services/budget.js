const { pool } = require('../lib/db');
const { fail, toCents } = require('../lib/validate');
const { money } = require('../lib/format');
const notifications = require('./notifications');
const settings = require('./settings');

const balanceSelect = `
  SELECT b.*, d.name AS department_name,
    COALESCE(SUM(CASE WHEN bt.transaction_type IN ('Commitment', 'Commitment Release') THEN bt.amount END), 0) AS committed_amount,
    COALESCE(SUM(CASE WHEN bt.transaction_type = 'Actual' THEN bt.amount END), 0) AS actual_amount
  FROM budgets b
  JOIN departments d ON d.id = b.department_id
  LEFT JOIN budget_transactions bt ON bt.budget_id = b.id`;

function withDerived(row) {
  if (!row) return null;
  const allocated = Number(row.allocated_amount);
  const committed = Number(row.committed_amount);
  const actual = Number(row.actual_amount);
  const remaining = Math.round((allocated - committed - actual) * 100) / 100;
  const utilization = allocated > 0 ? ((committed + actual) / allocated) * 100 : 0;
  return { ...row, allocated_amount: allocated, committed_amount: committed, actual_amount: actual,
    remaining_amount: remaining, utilization };
}

async function getBalance(connection, budgetId) {
  const [rows] = await (connection || pool()).execute(`${balanceSelect} WHERE b.id = ? GROUP BY b.id`, [budgetId]);
  return withDerived(rows[0]);
}

/** Most specific active budget (monthly before annual) covering the date. */
async function findBudgetFor(connection, departmentId, onDate) {
  if (!departmentId) return null;
  const [rows] = await (connection || pool()).execute(
    `SELECT id FROM budgets
     WHERE department_id = ? AND status = 'Active' AND ? BETWEEN period_start AND period_end
     ORDER BY period_type = 'Monthly' DESC, id DESC LIMIT 1`,
    [departmentId, onDate]
  );
  return rows[0] ? getBalance(connection, rows[0].id) : null;
}

async function post(connection, { budgetId, purchaseOrderId = null, deliveryId = null, type, amount, description, dedupeKey, userId }) {
  await connection.execute(
    `INSERT IGNORE INTO budget_transactions
      (budget_id, purchase_order_id, delivery_id, transaction_type, amount, description, dedupe_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [budgetId, purchaseOrderId, deliveryId, type, amount, String(description).slice(0, 500), dedupeKey, userId]
  );
}

async function checkThreshold(connection, budgetId) {
  const budget = await getBalance(connection, budgetId);
  if (!budget || budget.allocated_amount <= 0) return;
  const level = budget.utilization >= 100 ? 'exceeded' : budget.utilization >= Number(budget.warning_threshold) ? 'warning' : null;
  if (!level) return;
  await notifications.notifyPermission(connection, ['budgets.manage'], {
    type: 'budget_threshold',
    title: level === 'exceeded' ? `Budget exceeded: ${budget.name}` : `Budget threshold reached: ${budget.name}`,
    message: `${budget.department_name} has used ${budget.utilization.toFixed(1)}% of ${money(budget.allocated_amount)} (remaining ${money(budget.remaining_amount)}).`,
    link: `/budgets/${budget.id}`,
    referenceType: 'budget',
    referenceId: budget.id,
    dedupeKey: `budget:${budget.id}:${level}`
  });
}

/**
 * Commits an approved order's total against its department budget. Returns the
 * budget used (or null when the order has no department/budget).
 */
async function commitOrder(connection, order, userId) {
  const budget = await findBudgetFor(connection, order.department_id, order.order_date || new Date().toISOString().slice(0, 10));
  if (!budget) return { budget: null, warning: order.department_id ? 'No active budget covers this order date; no commitment was recorded.' : null };
  const total = Number(order.total_cost);
  let warning = null;
  if (toCents(total) > toCents(budget.remaining_amount)) {
    const policy = await settings.get('budget_overrun_policy', connection);
    const message = `${order.po_number} (${money(total)}) exceeds the remaining ${budget.name} budget of ${money(budget.remaining_amount)}.`;
    if (policy === 'block') fail(`${message} Increase the budget or change the order before approving.`);
    warning = message;
  }
  await post(connection, {
    budgetId: budget.id, purchaseOrderId: order.id, type: 'Commitment', amount: total,
    description: `Commitment for approved purchase order ${order.po_number}`,
    dedupeKey: `commit:po:${order.id}`, userId
  });
  await connection.execute('UPDATE purchase_orders SET budget_id = ? WHERE id = ?', [budget.id, order.id]);
  await checkThreshold(connection, budget.id);
  return { budget, warning };
}

async function outstandingCommitment(connection, orderId) {
  const [rows] = await connection.execute(
    `SELECT budget_id, COALESCE(SUM(amount), 0) AS outstanding FROM budget_transactions
     WHERE purchase_order_id = ? AND transaction_type IN ('Commitment', 'Commitment Release')
     GROUP BY budget_id`,
    [orderId]
  );
  return rows[0] ? { budgetId: rows[0].budget_id, amount: Number(rows[0].outstanding) } : null;
}

/** Releases whatever commitment remains for an order (cancellation or completion). */
async function releaseOrder(connection, order, reason, userId) {
  const outstanding = await outstandingCommitment(connection, order.id);
  if (!outstanding || outstanding.amount <= 0) return;
  await post(connection, {
    budgetId: outstanding.budgetId, purchaseOrderId: order.id, type: 'Commitment Release',
    amount: -outstanding.amount,
    description: `Commitment released for ${order.po_number} (${reason})`,
    dedupeKey: `release:po:${order.id}:${reason}`, userId
  });
}

/**
 * Policy: actual spending is recognized when accepted goods are received. The
 * accepted value (including the order's proportional discount and tax) is posted
 * as Actual and the same amount of commitment is released.
 */
async function recordDeliveryActual(connection, order, deliveryId, acceptedValue, userId) {
  if (!order.budget_id || acceptedValue <= 0) return;
  await post(connection, {
    budgetId: order.budget_id, purchaseOrderId: order.id, deliveryId, type: 'Actual', amount: acceptedValue,
    description: `Received goods for ${order.po_number}`, dedupeKey: `actual:delivery:${deliveryId}`, userId
  });
  const outstanding = await outstandingCommitment(connection, order.id);
  const release = outstanding ? Math.min(outstanding.amount, acceptedValue) : 0;
  if (release > 0) {
    await post(connection, {
      budgetId: order.budget_id, purchaseOrderId: order.id, deliveryId, type: 'Commitment Release', amount: -release,
      description: `Commitment converted to actual spending for ${order.po_number}`,
      dedupeKey: `release:delivery:${deliveryId}`, userId
    });
  }
  await checkThreshold(connection, order.budget_id);
}

module.exports = {
  balanceSelect, withDerived, getBalance, findBudgetFor, commitOrder, releaseOrder,
  recordDeliveryActual, checkThreshold
};
