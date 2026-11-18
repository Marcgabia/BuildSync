const { withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { forbidden, notFound, isDuplicateError } = require('../lib/http');
const { assignDocumentNumber, temporaryNumber } = require('../lib/sequence');
const { money } = require('../lib/format');
const audit = require('./audit');
const notifications = require('./notifications');
const budget = require('./budget');

const statuses = ['Draft', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received', 'Completed', 'Cancelled'];
const receivableStatuses = ['Approved', 'Ordered', 'Partially Received'];
const cancellableStatuses = ['Draft', 'Pending Approval', 'Approved', 'Ordered'];

/** Server-side totals in integer cents: subtotal − discount + tax on the net amount. */
function computeTotals(items, discountCents, taxRate) {
  const subtotalCents = items.reduce((sum, item) => sum + item.quantity * item.price_cents, 0);
  if (discountCents > subtotalCents) v.fail('The discount cannot be larger than the subtotal.');
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Math.round(taxableCents * taxRate / 100);
  const totalCents = taxableCents + taxCents;
  if (totalCents > 99999999999999) v.fail('The purchase order total is above the supported limit.');
  return { subtotalCents, discountCents, taxCents, totalCents };
}

function validateForm(body) {
  const values = {
    po_number: v.optionalText(body.po_number, 'PO number', 50),
    supplier_id: v.id(body.supplier_id, 'Supplier'),
    department_id: String(body.department_id || '').trim() ? v.id(body.department_id, 'Department') : null,
    order_date: v.date(body.order_date || v.today(), 'Order date'),
    target_date: v.date(body.target_date, 'Expected delivery date'),
    notes: v.optionalText(body.notes, 'Notes', 5000),
    discount_cents: v.moneyCents(body.discount_amount, 'Discount', { required: false }),
    tax_rate: v.percent(body.tax_rate, 'Tax rate', { required: false, max: 50 })
  };
  if (values.po_number && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(values.po_number)) {
    v.fail('PO numbers may only contain letters, numbers, dots, dashes, and slashes.');
  }
  if (values.target_date < values.order_date) v.fail('The expected delivery date cannot be before the order date.');

  const productIds = v.list(body.product_id);
  const quantities = v.list(body.quantity);
  const prices = v.list(body.unit_price);
  const descriptions = v.list(body.item_description);
  values.items = [];
  productIds.forEach((productId, index) => {
    if (!String(productId || '').trim()) return;
    values.items.push({
      product_id: v.id(productId, `Product on line ${index + 1}`),
      quantity: v.integer(quantities[index], `Quantity on line ${index + 1}`, { min: 1, max: 1000000 }),
      price_cents: v.moneyCents(prices[index], `Unit price on line ${index + 1}`, { max: 9999999999 }),
      description: v.optionalText(descriptions[index], `Description on line ${index + 1}`, 1000)
    });
  });
  if (!values.items.length) v.fail('Add at least one product to the purchase order.');
  if (values.items.length > 100) v.fail('A purchase order can contain at most 100 lines.');
  values.totals = computeTotals(values.items, values.discount_cents, values.tax_rate);
  return values;
}

async function assertSupplierActive(connection, supplierId) {
  const [rows] = await connection.execute("SELECT id FROM suppliers WHERE id = ? AND status = 'Active'", [supplierId]);
  if (!rows[0]) v.fail('Choose an active supplier before saving the purchase order.');
}

async function writeItems(connection, orderId, items) {
  await connection.execute('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [orderId]);
  for (const [index, item] of items.entries()) {
    const [rows] = await connection.execute(
      "SELECT id, product_code, name, description FROM products WHERE id = ? AND status = 'Active'", [item.product_id]
    );
    const product = rows[0];
    if (!product) v.fail(`The product on line ${index + 1} is not available.`);
    await connection.execute(
      `INSERT INTO purchase_order_items
        (purchase_order_id, line_no, product_id, item_code, description, quantity, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, index + 1, product.id, product.product_code, item.description || product.name,
        item.quantity, v.centsToAmount(item.price_cents), v.centsToAmount(item.quantity * item.price_cents)]
    );
  }
}

function totalsColumns(values) {
  const t = values.totals;
  return [v.centsToAmount(t.subtotalCents), v.centsToAmount(t.discountCents), values.tax_rate,
    v.centsToAmount(t.taxCents), v.centsToAmount(t.totalCents)];
}

async function notifyApprovers(connection, req, order) {
  await notifications.notifyPermission(connection, 'purchase_orders.approve', {
    type: 'po_pending_approval',
    title: `Purchase order ${order.po_number} awaits approval`,
    message: `${req.user.fullName} submitted ${order.po_number} (${money(order.total_cost)}) for approval.`,
    link: `/purchase-orders/${order.id}`, referenceType: 'purchase_order', referenceId: order.id
  }, { exceptUserId: req.user.id });
}

/**
 * Creates a purchase order (optionally from an approved requisition). The
 * requisition row is locked and the active_requisition_id UNIQUE index makes a
 * second live conversion impossible even under concurrent requests.
 */
async function create(req, values, { requisitionId = null, submit = false } = {}) {
  try {
    return await withTransaction(async (connection) => {
      await assertSupplierActive(connection, values.supplier_id);
      let departmentId = values.department_id;
      let requisition = null;
      if (requisitionId) {
        const [rows] = await connection.execute(
          'SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [requisitionId]
        );
        requisition = rows[0];
        if (!requisition) throw notFound('The requisition no longer exists.');
        if (requisition.status !== 'Approved') {
          v.fail(requisition.status === 'Converted to Purchase Order'
            ? 'This requisition has already been converted into a purchase order.'
            : 'Only approved requisitions can be converted into purchase orders.');
        }
        departmentId = requisition.department_id;
      }
      const status = submit ? 'Pending Approval' : 'Draft';
      const [result] = await connection.execute(
        `INSERT INTO purchase_orders
          (po_number, supplier_id, requisition_id, department_id, created_by, order_date,
           subtotal, discount_amount, tax_rate, tax_amount, total_cost, status, target_date, notes, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.po_number || temporaryNumber('PO'), values.supplier_id, requisitionId, departmentId, req.user.id,
          values.order_date, ...totalsColumns(values), status, values.target_date, values.notes,
          submit ? new Date() : null]
      );
      const id = result.insertId;
      const poNumber = values.po_number || await assignDocumentNumber(connection, {
        table: 'purchase_orders', column: 'po_number', prefix: 'PO', id
      });
      await writeItems(connection, id, values.items);
      if (requisition) {
        await connection.execute(
          "UPDATE purchase_requisitions SET status = 'Converted to Purchase Order' WHERE id = ?", [requisitionId]
        );
      }
      await audit.log(connection, req, {
        action: 'create', module: 'Purchase Orders', recordId: id,
        description: `Created purchase order ${poNumber} (${money(v.centsToAmount(values.totals.totalCents))})` +
          `${requisition ? ` from requisition ${requisition.requisition_number}` : ''}.`
      });
      if (submit) {
        await notifyApprovers(connection, req, { id, po_number: poNumber, total_cost: v.centsToAmount(values.totals.totalCents) });
      }
      return id;
    });
  } catch (error) {
    if (isDuplicateError(error)) {
      v.fail(/active_requisition/.test(error.message)
        ? 'This requisition already has an active purchase order.'
        : 'That purchase order number is already in use.');
    }
    throw error;
  }
}

async function lockOrder(connection, id) {
  const [rows] = await connection.execute('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function update(req, id, values, { submit = false } = {}) {
  try {
    return await withTransaction(async (connection) => {
      const order = await lockOrder(connection, id);
      if (order.status !== 'Draft') v.fail('Only draft purchase orders can be edited. Approved and completed orders are locked.');
      await assertSupplierActive(connection, values.supplier_id);
      const departmentId = order.requisition_id ? order.department_id : values.department_id;
      await connection.execute(
        `UPDATE purchase_orders SET po_number = ?, supplier_id = ?, department_id = ?, order_date = ?,
           subtotal = ?, discount_amount = ?, tax_rate = ?, tax_amount = ?, total_cost = ?, target_date = ?, notes = ?
         WHERE id = ?`,
        [values.po_number || order.po_number, values.supplier_id, departmentId, values.order_date,
          ...totalsColumns(values), values.target_date, values.notes, id]
      );
      await writeItems(connection, id, values.items);
      await audit.log(connection, req, {
        action: 'update', module: 'Purchase Orders', recordId: id,
        description: `Updated draft purchase order ${values.po_number || order.po_number}.`
      });
      if (submit) await submitLocked(connection, req, { ...order, total_cost: v.centsToAmount(values.totals.totalCents) });
    });
  } catch (error) {
    if (isDuplicateError(error)) v.fail('That purchase order number is already in use.');
    throw error;
  }
}

async function submitLocked(connection, req, order) {
  if (order.status !== 'Draft') v.fail('Only draft purchase orders can be submitted for approval.');
  await connection.execute(
    "UPDATE purchase_orders SET status = 'Pending Approval', current_approval_level = 0, submitted_at = NOW() WHERE id = ?",
    [order.id]
  );
  await audit.log(connection, req, {
    action: 'submit', module: 'Purchase Orders', recordId: order.id,
    description: `Submitted purchase order ${order.po_number} for approval.`
  });
  await notifyApprovers(connection, req, order);
}

async function submit(req, id) {
  return withTransaction(async (connection) => submitLocked(connection, req, await lockOrder(connection, id)));
}

async function markOrdered(req, id) {
  return withTransaction(async (connection) => {
    const order = await lockOrder(connection, id);
    if (order.status !== 'Approved') v.fail('Only approved purchase orders can be marked as sent to the supplier.');
    await connection.execute("UPDATE purchase_orders SET status = 'Ordered', ordered_at = NOW() WHERE id = ?", [id]);
    await audit.log(connection, req, {
      action: 'order', module: 'Purchase Orders', recordId: id,
      description: `Marked purchase order ${order.po_number} as ordered from the supplier.`
    });
  });
}

async function cancel(req, id, reasonInput) {
  const reason = v.text(reasonInput, 'Cancellation reason', { max: 500 });
  return withTransaction(async (connection) => {
    const order = await lockOrder(connection, id);
    if (!cancellableStatuses.includes(order.status)) {
      v.fail(`A purchase order with status "${order.status}" cannot be cancelled.`);
    }
    if (['Approved', 'Ordered'].includes(order.status) && !req.can('purchase_orders.approve')) {
      throw forbidden('Only approvers can cancel approved purchase orders.');
    }
    const [[received]] = await connection.execute(
      'SELECT COALESCE(SUM(received_quantity), 0) AS total FROM purchase_order_items WHERE purchase_order_id = ?', [id]
    );
    if (Number(received.total) > 0) v.fail('Goods have already been received for this order, so it cannot be cancelled.');
    await connection.execute(
      "UPDATE purchase_orders SET status = 'Cancelled', cancelled_at = NOW(), cancel_reason = ? WHERE id = ?",
      [reason, id]
    );
    await budget.releaseOrder(connection, order, 'cancelled', req.user.id);
    if (order.requisition_id) {
      await connection.execute(
        "UPDATE purchase_requisitions SET status = 'Approved' WHERE id = ? AND status = 'Converted to Purchase Order'",
        [order.requisition_id]
      );
    }
    await audit.log(connection, req, {
      action: 'cancel', module: 'Purchase Orders', recordId: id,
      description: `Cancelled purchase order ${order.po_number}: ${reason}`
    });
    if (order.created_by && Number(order.created_by) !== req.user.id) {
      await notifications.notifyUser(connection, order.created_by, {
        type: 'po_decision', title: `Purchase order ${order.po_number} was cancelled`,
        message: `${req.user.fullName}: ${reason}`, link: `/purchase-orders/${id}`,
        referenceType: 'purchase_order', referenceId: id
      });
    }
  });
}

module.exports = {
  statuses, receivableStatuses, cancellableStatuses, computeTotals, validateForm,
  create, update, submit, markOrdered, cancel, lockOrder
};
