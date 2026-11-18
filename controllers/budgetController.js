const { pool } = require('../lib/db');
const v = require('../lib/validate');
const { handle, paramId, notFound, isDuplicateError, isUserError, sendCsv } = require('../lib/http');
const { money } = require('../lib/format');
const Budget = require('../models/budget');
const { Department } = require('../models/user');
const audit = require('../services/audit');
const budgetService = require('../services/budget');
const settings = require('../services/settings');
const { action } = require('./helpers');

const statuses = ['Active', 'Inactive', 'Closed'];

function readFilters(query) {
  return {
    departmentId: v.isValidId(query.department) ? Number(query.department) : 0,
    year: /^\d{4}$/.test(query.year || '') ? Number(query.year) : 0,
    status: statuses.includes(query.status) ? query.status : 'All'
  };
}

function validateBudget(body) {
  const periodType = v.oneOf(body.period_type, 'Budget period', ['Annual', 'Monthly']);
  const year = v.integer(body.fiscal_year, 'Fiscal year', { min: 2000, max: 2100 });
  const month = periodType === 'Monthly' ? v.integer(body.period_month, 'Month', { min: 1, max: 12 }) : 0;
  const start = periodType === 'Monthly' ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`;
  const endDate = periodType === 'Monthly' ? new Date(Date.UTC(year, month, 0)) : new Date(Date.UTC(year, 11, 31));
  return {
    name: v.text(body.name, 'Budget name', { max: 150 }),
    department_id: v.id(body.department_id, 'Department'),
    period_type: periodType,
    fiscal_year: year,
    period_month: month,
    period_start: start,
    period_end: endDate.toISOString().slice(0, 10),
    allocated_amount: v.centsToAmount(v.moneyCents(body.allocated_amount, 'Allocated amount', { max: 99999999999999 })),
    warning_threshold: v.percent(body.warning_threshold, 'Warning threshold', { min: 1, max: 100 }),
    status: v.oneOf(body.status || 'Active', 'Status', statuses),
    notes: v.optionalText(body.notes, 'Notes', 1000)
  };
}

const index = handle(async (req, res) => {
  const filters = readFilters(req.query);
  const budgets = await Budget.list(filters);
  const totals = budgets.reduce((sum, b) => ({
    allocated: sum.allocated + b.allocated_amount, committed: sum.committed + b.committed_amount,
    actual: sum.actual + b.actual_amount, remaining: sum.remaining + b.remaining_amount
  }), { allocated: 0, committed: 0, actual: 0, remaining: 0 });
  res.render('budgets/index', {
    budgets, totals, filters, statuses, departments: await Department.active(), years: await Budget.years(),
    values: { fiscal_year: new Date().getFullYear(), warning_threshold: await settings.get('budget_warning_threshold'), period_type: 'Annual', status: 'Active' },
    error: null
  });
});

const exportCsv = handle(async (req, res) => {
  sendCsv(res, 'budgets.csv', [
    { label: 'Budget', key: 'name' }, { label: 'Department', key: 'department_name' },
    { label: 'Period', value: (b) => (b.period_type === 'Monthly' ? `${b.fiscal_year}-${String(b.period_month).padStart(2, '0')}` : b.fiscal_year) },
    { label: 'Allocated', key: 'allocated_amount' }, { label: 'Committed', key: 'committed_amount' },
    { label: 'Actual spending', key: 'actual_amount' }, { label: 'Remaining', key: 'remaining_amount' },
    { label: 'Utilization %', value: (b) => b.utilization.toFixed(2) }, { label: 'Status', key: 'status' }
  ], await Budget.list(readFilters(req.query)));
});

const create = handle(async (req, res) => {
  try {
    const values = validateBudget(req.body);
    const [result] = await pool().execute(
      `INSERT INTO budgets (name, department_id, period_type, fiscal_year, period_month, period_start, period_end,
         allocated_amount, warning_threshold, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, values.department_id, values.period_type, values.fiscal_year, values.period_month,
        values.period_start, values.period_end, values.allocated_amount, values.warning_threshold, values.status,
        values.notes, req.user.id]
    );
    await audit.log(null, req, {
      action: 'create', module: 'Budgets', recordId: result.insertId,
      description: `Created budget ${values.name} (${values.period_start} to ${values.period_end}) with ${money(values.allocated_amount)}.`
    });
    await req.flash('success', 'Budget created.');
    res.redirect(`/budgets/${result.insertId}`);
  } catch (error) {
    const message = isDuplicateError(error) ? 'A budget for that department and period already exists.'
      : isUserError(error) ? error.message : null;
    if (!message) throw error;
    const filters = readFilters({});
    const budgets = await Budget.list(filters);
    res.status(400).render('budgets/index', {
      budgets, totals: null, filters, statuses, departments: await Department.active(), years: await Budget.years(),
      values: req.body, error: message
    });
  }
});

const view = handle(async (req, res) => {
  const budget = await Budget.findById(paramId(req));
  if (!budget) throw notFound();
  const [orders] = await pool().execute(
    `SELECT po.id, po.po_number, po.status, po.total_cost, po.order_date, s.vendor_name
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.budget_id = ? ORDER BY po.order_date DESC`,
    [budget.id]
  );
  res.render('budgets/show', { budget, transactions: await Budget.transactions(budget.id), orders });
});

const editForm = handle(async (req, res) => {
  const budget = await Budget.findById(paramId(req));
  if (!budget) throw notFound();
  res.render('budgets/edit', { budget, values: budget, statuses, departments: await Department.active(), error: null });
});

const update = handle(async (req, res) => {
  const id = paramId(req);
  const budget = await Budget.findById(id);
  if (!budget) throw notFound();
  try {
    const values = validateBudget(req.body);
    const [[usage]] = await pool().execute('SELECT COUNT(*) AS total FROM budget_transactions WHERE budget_id = ?', [id]);
    if (Number(usage.total) > 0 && (values.department_id !== Number(budget.department_id) ||
        values.period_start !== budget.period_start || values.period_end !== budget.period_end)) {
      v.fail('This budget already has commitments or spending, so its department and period cannot change.');
    }
    await pool().execute(
      `UPDATE budgets SET name = ?, department_id = ?, period_type = ?, fiscal_year = ?, period_month = ?,
         period_start = ?, period_end = ?, allocated_amount = ?, warning_threshold = ?, status = ?, notes = ? WHERE id = ?`,
      [values.name, values.department_id, values.period_type, values.fiscal_year, values.period_month,
        values.period_start, values.period_end, values.allocated_amount, values.warning_threshold, values.status,
        values.notes, id]
    );
    await audit.log(null, req, {
      action: 'update', module: 'Budgets', recordId: id,
      description: `Updated budget ${values.name}: allocation ${money(budget.allocated_amount)} → ${money(values.allocated_amount)}, ` +
        `threshold ${values.warning_threshold}%, status ${values.status}.`
    });
    await budgetService.checkThreshold(pool(), id);
    await req.flash('success', 'Budget updated.');
    res.redirect(`/budgets/${id}`);
  } catch (error) {
    const message = isDuplicateError(error) ? 'A budget for that department and period already exists.'
      : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('budgets/edit', {
      budget, values: { ...budget, ...req.body }, statuses, departments: await Department.active(), error: message
    });
  }
});

const remove = action(async (req) => {
  const id = paramId(req);
  const budget = await Budget.findById(id);
  if (!budget) throw notFound();
  const [[usage]] = await pool().execute(
    'SELECT (SELECT COUNT(*) FROM budget_transactions WHERE budget_id = ?) + (SELECT COUNT(*) FROM purchase_orders WHERE budget_id = ?) AS total',
    [id, id]
  );
  if (Number(usage.total) > 0) v.fail('This budget has commitments or spending on record. Close it instead of deleting it.');
  await pool().execute('DELETE FROM budgets WHERE id = ?', [id]);
  await audit.log(null, req, { action: 'delete', module: 'Budgets', recordId: id, description: `Deleted unused budget ${budget.name}.` });
}, { success: 'Budget deleted.', redirect: '/budgets' });

module.exports = { index, exportCsv, create, view, editForm, update, remove };
