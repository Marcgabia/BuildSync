const { withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { forbidden, notFound } = require('../lib/http');
const { assignDocumentNumber, temporaryNumber } = require('../lib/sequence');
const audit = require('./audit');
const notifications = require('./notifications');

const statuses = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected',
  'Returned for Revision', 'Converted to Purchase Order', 'Cancelled'];
const editableStatuses = ['Draft', 'Returned for Revision'];
const cancellableStatuses = ['Draft', 'Submitted', 'Under Review', 'Returned for Revision', 'Approved'];

/** Validates the requisition form; item prices default to the catalog price. */
function validateForm(body, user, { canChooseDepartment }) {
  const values = {
    department_id: canChooseDepartment || !user.departmentId
      ? v.id(body.department_id, 'Department')
      : Number(user.departmentId),
    required_date: v.date(body.required_date, 'Required date'),
    purpose: v.text(body.purpose, 'Purpose or justification', { max: 5000 })
  };
  if (values.required_date < v.today()) v.fail('The required date cannot be in the past.');

  const productIds = v.list(body.product_id);
  const quantities = v.list(body.quantity);
  const prices = v.list(body.unit_price);
  const descriptions = v.list(body.item_description);
  const items = [];
  productIds.forEach((productId, index) => {
    if (!String(productId || '').trim()) return;
    items.push({
      product_id: v.id(productId, `Product on line ${index + 1}`),
      quantity: v.integer(quantities[index], `Quantity on line ${index + 1}`, { min: 1, max: 1000000 }),
      price_cents: String(prices[index] || '').trim() === ''
        ? null
        : v.moneyCents(prices[index], `Estimated unit price on line ${index + 1}`),
      description: v.optionalText(descriptions[index], `Description on line ${index + 1}`, 500)
    });
  });
  if (!items.length) v.fail('Add at least one product to the requisition.');
  if (items.length > 100) v.fail('A requisition can contain at most 100 lines.');
  return { ...values, items };
}

async function writeItems(connection, requisitionId, items) {
  await connection.execute('DELETE FROM requisition_items WHERE requisition_id = ?', [requisitionId]);
  let totalCents = 0;
  for (const [index, item] of items.entries()) {
    const [rows] = await connection.execute(
      "SELECT id, name, unit_price FROM products WHERE id = ? AND status = 'Active'", [item.product_id]
    );
    if (!rows[0]) v.fail(`The product on line ${index + 1} is not available.`);
    const priceCents = item.price_cents === null ? v.toCents(rows[0].unit_price) : item.price_cents;
    const subtotalCents = priceCents * item.quantity;
    totalCents += subtotalCents;
    await connection.execute(
      `INSERT INTO requisition_items
        (requisition_id, line_no, product_id, description, quantity, estimated_unit_price, subtotal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [requisitionId, index + 1, item.product_id, item.description, item.quantity,
        v.centsToAmount(priceCents), v.centsToAmount(subtotalCents)]
    );
  }
  if (totalCents > 99999999999999) v.fail('The requisition total is above the supported limit.');
  await connection.execute('UPDATE purchase_requisitions SET total_estimated = ? WHERE id = ?',
    [v.centsToAmount(totalCents), requisitionId]);
}

async function lockOwned(connection, id, user) {
  const [rows] = await connection.execute('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [id]);
  const record = rows[0];
  if (!record) throw notFound();
  if (Number(record.requested_by) !== user.id) throw forbidden('Only the requester can change this requisition.');
  return record;
}

async function notifyApprovers(connection, requisition, req) {
  await notifications.notifyPermission(connection, 'requisitions.approve', {
    type: 'requisition_submitted',
    title: `Requisition ${requisition.requisition_number} needs review`,
    message: `${req.user.fullName} submitted a purchase requisition for approval.`,
    link: `/requisitions/${requisition.id}`,
    referenceType: 'requisition',
    referenceId: requisition.id
  }, { exceptUserId: req.user.id });
}

async function submitInTransaction(connection, record, req) {
  await connection.execute(
    `UPDATE purchase_requisitions SET status = 'Submitted', current_approval_level = 0,
       submitted_at = NOW(), decided_at = NULL WHERE id = ?`,
    [record.id]
  );
  await audit.log(connection, req, {
    action: 'submit', module: 'Requisitions', recordId: record.id,
    description: `Submitted requisition ${record.requisition_number} for approval.`
  });
  await notifyApprovers(connection, record, req);
}

async function create(req, values, { submit = false } = {}) {
  return withTransaction(async (connection) => {
    const [result] = await connection.execute(
      `INSERT INTO purchase_requisitions
        (requisition_number, requested_by, department_id, request_date, required_date, purpose)
       VALUES (?, ?, ?, CURDATE(), ?, ?)`,
      [temporaryNumber('PR'), req.user.id, values.department_id, values.required_date, values.purpose]
    );
    const id = result.insertId;
    const number = await assignDocumentNumber(connection, {
      table: 'purchase_requisitions', column: 'requisition_number', prefix: 'PR', id
    });
    await writeItems(connection, id, values.items);
    await audit.log(connection, req, {
      action: 'create', module: 'Requisitions', recordId: id, description: `Created requisition ${number}.`
    });
    if (submit) await submitInTransaction(connection, { id, requisition_number: number }, req);
    return id;
  });
}

async function update(req, id, values, { submit = false } = {}) {
  return withTransaction(async (connection) => {
    const record = await lockOwned(connection, id, req.user);
    if (!editableStatuses.includes(record.status)) v.fail('Only draft or returned requisitions can be edited.');
    await connection.execute(
      'UPDATE purchase_requisitions SET department_id = ?, required_date = ?, purpose = ? WHERE id = ?',
      [values.department_id, values.required_date, values.purpose, id]
    );
    await writeItems(connection, id, values.items);
    await audit.log(connection, req, {
      action: 'update', module: 'Requisitions', recordId: id,
      description: `Updated requisition ${record.requisition_number}.`
    });
    if (submit) await submitInTransaction(connection, record, req);
  });
}

async function submit(req, id) {
  return withTransaction(async (connection) => {
    const record = await lockOwned(connection, id, req.user);
    if (!editableStatuses.includes(record.status)) v.fail('Only draft or returned requisitions can be submitted.');
    const [[count]] = await connection.execute(
      'SELECT COUNT(*) AS total FROM requisition_items WHERE requisition_id = ?', [id]
    );
    if (!Number(count.total)) v.fail('Add at least one item before submitting.');
    await submitInTransaction(connection, record, req);
  });
}

async function cancel(req, id) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [id]);
    const record = rows[0];
    if (!record) throw notFound();
    const isOwner = Number(record.requested_by) === req.user.id;
    if (!isOwner && !req.can('requisitions.approve')) throw forbidden('Only the requester or an approver can cancel this requisition.');
    if (!cancellableStatuses.includes(record.status)) v.fail(`A requisition with status "${record.status}" cannot be cancelled.`);
    await connection.execute(
      "UPDATE purchase_requisitions SET status = 'Cancelled', decided_at = NOW() WHERE id = ?", [id]
    );
    await audit.log(connection, req, {
      action: 'cancel', module: 'Requisitions', recordId: id,
      description: `Cancelled requisition ${record.requisition_number}.`
    });
    if (!isOwner) {
      await notifications.notifyUser(connection, record.requested_by, {
        type: 'requisition_decision',
        title: `Requisition ${record.requisition_number} was cancelled`,
        message: `${req.user.fullName} cancelled your requisition.`,
        link: `/requisitions/${id}`, referenceType: 'requisition', referenceId: id
      });
    }
  });
}

module.exports = { statuses, editableStatuses, cancellableStatuses, validateForm, create, update, submit, cancel };
