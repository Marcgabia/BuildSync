const { withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { notFound, isDuplicateError } = require('../lib/http');
const { assignDocumentNumber, temporaryNumber } = require('../lib/sequence');
const audit = require('./audit');
const notifications = require('./notifications');
const inventory = require('./inventory');
const budget = require('./budget');
const { receivableStatuses } = require('./purchaseOrders');

const statuses = ['Pending', 'In Transit', 'Partially Received', 'Fully Received', 'Delayed', 'Rejected'];
const openStatuses = ['Pending', 'In Transit', 'Delayed'];

function validateHeader(body) {
  return {
    purchase_order_id: v.id(body.purchase_order_id, 'Purchase order'),
    reference_number: v.optionalText(body.reference_number, 'Delivery reference number', 100),
    expected_date: v.date(body.expected_date, 'Expected delivery date', { required: false }),
    delivery_date: v.date(body.delivery_date, 'Delivery date', { required: false }),
    status: v.oneOf(body.status || 'Pending', 'Delivery status', openStatuses),
    remarks: v.optionalText(body.remarks, 'Remarks', 5000)
  };
}

function validateLines(body) {
  const itemIds = v.list(body.po_item_id);
  const received = v.list(body.received_quantity);
  const damaged = v.list(body.damaged_quantity);
  const remarks = v.list(body.line_remarks);
  const lines = itemIds.map((itemId, index) => ({
    po_item_id: v.id(itemId, `Order line ${index + 1}`),
    received: v.integer(received[index] || 0, `Received quantity on line ${index + 1}`, { min: 0, max: 1000000 }),
    damaged: v.integer(damaged[index] || 0, `Damaged quantity on line ${index + 1}`, { min: 0, max: 1000000 }),
    remarks: v.optionalText(remarks[index], `Remarks on line ${index + 1}`, 500)
  })).filter((line) => line.received > 0 || line.damaged > 0);
  for (const line of lines) {
    if (line.damaged > line.received) v.fail('Damaged quantity cannot be greater than the received quantity.');
  }
  return lines;
}

async function lockReceivableOrder(connection, orderId) {
  const [rows] = await connection.execute('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [orderId]);
  const order = rows[0];
  if (!order) throw notFound('The purchase order no longer exists.');
  if (!receivableStatuses.includes(order.status)) {
    v.fail(`Deliveries can only be recorded for approved or ordered purchase orders (this one is "${order.status}").`);
  }
  return order;
}

/**
 * Confirms receipt for a delivery inside the caller's transaction:
 * validates remaining quantities, stores delivery lines, increases stock by the
 * accepted quantity only, records actual spending, and advances the PO status.
 */
async function receiveLocked(connection, req, delivery, order, lines, deliveryDate) {
  if (!lines.length) v.fail('Enter the received quantity for at least one item.');
  const [items] = await connection.execute(
    'SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY line_no FOR UPDATE', [order.id]
  );
  const byId = new Map(items.map((item) => [Number(item.id), item]));
  let acceptedCents = 0;
  let acceptedTotal = 0;
  for (const line of lines) {
    const item = byId.get(line.po_item_id);
    if (!item) v.fail('A delivery line does not belong to this purchase order.');
    const remaining = Number(item.quantity) - Number(item.received_quantity);
    if (line.received > remaining) {
      v.fail(`${item.item_code}: received quantity (${line.received}) exceeds the remaining ordered quantity (${remaining}).`);
    }
    const accepted = line.received - line.damaged;
    const [result] = await connection.execute(
      `INSERT INTO delivery_items
        (delivery_id, purchase_order_item_id, product_id, ordered_quantity, previously_received,
         received_quantity, damaged_quantity, accepted_quantity, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [delivery.id, item.id, item.product_id, item.quantity, item.received_quantity,
        line.received, line.damaged, accepted, line.remarks]
    );
    await connection.execute(
      `UPDATE purchase_order_items SET received_quantity = received_quantity + ?,
         damaged_quantity = damaged_quantity + ? WHERE id = ?`,
      [accepted, line.damaged, item.id]
    );
    item.received_quantity = Number(item.received_quantity) + accepted;
    if (item.product_id && accepted > 0) {
      await inventory.postMovement(connection, {
        productId: item.product_id, quantity: accepted, type: 'Receipt',
        referenceType: 'delivery_item', referenceId: result.insertId,
        notes: `Received via ${delivery.delivery_number} for ${order.po_number}`, userId: req.user.id
      });
    }
    acceptedCents += accepted * v.toCents(item.unit_price);
    acceptedTotal += accepted;
  }

  const complete = items.every((item) => Number(item.received_quantity) >= Number(item.quantity));
  const deliveryStatus = acceptedTotal === 0 ? 'Rejected' : complete ? 'Fully Received' : 'Partially Received';
  await connection.execute(
    `UPDATE deliveries SET status = ?, delivery_date = ?, received_by = ?, confirmed_at = NOW() WHERE id = ?`,
    [deliveryStatus, deliveryDate, req.user.id, delivery.id]
  );

  const anyReceived = items.some((item) => Number(item.received_quantity) > 0);
  const orderStatus = complete ? 'Completed' : anyReceived ? 'Partially Received' : order.status;
  await connection.execute(
    `UPDATE purchase_orders SET status = ?, completed_at = IF(? = 'Completed', NOW(), completed_at),
       ordered_at = COALESCE(ordered_at, NOW()) WHERE id = ?`,
    [orderStatus, orderStatus, order.id]
  );

  // Accepted value including the order's proportional discount and tax.
  const subtotalCents = v.toCents(order.subtotal);
  const factor = subtotalCents > 0 ? v.toCents(order.total_cost) / subtotalCents : 1;
  const acceptedValue = v.centsToAmount(Math.round(acceptedCents * factor));
  await budget.recordDeliveryActual(connection, order, delivery.id, acceptedValue, req.user.id);
  if (complete) await budget.releaseOrder(connection, order, 'completed', req.user.id);

  await audit.log(connection, req, {
    action: 'receive', module: 'Deliveries', recordId: delivery.id,
    description: `Confirmed delivery ${delivery.delivery_number} for ${order.po_number}: ${acceptedTotal} units accepted` +
      `${lines.some((line) => line.damaged) ? `, ${lines.reduce((sum, line) => sum + line.damaged, 0)} damaged` : ''}. ` +
      `Order is now ${orderStatus}.`
  });
  const recipients = new Set([order.created_by].filter(Boolean).map(Number));
  for (const userId of recipients) {
    if (userId === req.user.id) continue;
    await notifications.notifyUser(connection, userId, {
      type: 'delivery_received', title: `Delivery received for ${order.po_number}`,
      message: `${delivery.delivery_number}: ${acceptedTotal} units accepted. Order status: ${orderStatus}.`,
      link: `/deliveries/${delivery.id}`, referenceType: 'delivery', referenceId: delivery.id
    });
  }
  return { deliveryStatus, orderStatus };
}

async function create(req, header, lines, { receiveNow = false } = {}) {
  try {
    return await withTransaction(async (connection) => {
      const order = await lockReceivableOrder(connection, header.purchase_order_id);
      if (receiveNow && !header.delivery_date) header.delivery_date = v.today();
      const [result] = await connection.execute(
        `INSERT INTO deliveries
          (delivery_number, purchase_order_id, supplier_id, reference_number, expected_date, delivery_date,
           status, remarks, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [temporaryNumber('DR'), order.id, order.supplier_id, header.reference_number,
          header.expected_date || order.target_date, header.delivery_date, header.status, header.remarks, req.user.id]
      );
      const id = result.insertId;
      const number = await assignDocumentNumber(connection, { table: 'deliveries', column: 'delivery_number', prefix: 'DR', id });
      if (order.status === 'Approved') {
        await connection.execute("UPDATE purchase_orders SET status = 'Ordered', ordered_at = NOW() WHERE id = ?", [order.id]);
        order.status = 'Ordered';
      }
      await audit.log(connection, req, {
        action: 'create', module: 'Deliveries', recordId: id,
        description: `Recorded delivery ${number} for purchase order ${order.po_number}.`
      });
      if (receiveNow) {
        await receiveLocked(connection, req, { id, delivery_number: number }, order, lines, header.delivery_date);
      }
      return id;
    });
  } catch (error) {
    if (isDuplicateError(error)) v.fail('This supplier delivery reference number has already been recorded.');
    throw error;
  }
}

async function receive(req, deliveryId, lines, deliveryDate) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute('SELECT * FROM deliveries WHERE id = ? FOR UPDATE', [deliveryId]);
    const delivery = rows[0];
    if (!delivery) throw notFound();
    if (delivery.confirmed_at || !openStatuses.includes(delivery.status)) {
      v.fail('This delivery has already been confirmed and cannot be received twice.');
    }
    const order = await lockReceivableOrder(connection, delivery.purchase_order_id);
    return receiveLocked(connection, req, delivery, order, lines, deliveryDate || v.today());
  });
}

async function updateStatus(req, deliveryId, statusInput, remarksInput) {
  const status = v.oneOf(statusInput, 'Delivery status', [...openStatuses, 'Rejected']);
  const remarks = v.optionalText(remarksInput, 'Remarks', 5000);
  if (status === 'Rejected' && !remarks) v.fail('Explain why the delivery is being rejected.');
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT d.*, po.po_number, po.created_by AS po_created_by FROM deliveries d
       JOIN purchase_orders po ON po.id = d.purchase_order_id WHERE d.id = ? FOR UPDATE`, [deliveryId]
    );
    const delivery = rows[0];
    if (!delivery) throw notFound();
    if (delivery.confirmed_at || !openStatuses.includes(delivery.status)) v.fail('Confirmed deliveries cannot change status.');
    await connection.execute(
      `UPDATE deliveries SET status = ?, remarks = COALESCE(?, remarks),
         confirmed_at = IF(? = 'Rejected', NOW(), NULL), received_by = IF(? = 'Rejected', ?, received_by)
       WHERE id = ?`,
      [status, remarks, status, status, req.user.id, deliveryId]
    );
    await audit.log(connection, req, {
      action: 'status', module: 'Deliveries', recordId: deliveryId,
      description: `Changed delivery ${delivery.delivery_number} (${delivery.po_number}) to ${status}${remarks ? `: ${remarks}` : '.'}`
    });
    if (['Delayed', 'Rejected'].includes(status) && delivery.po_created_by) {
      await notifications.notifyUser(connection, delivery.po_created_by, {
        type: status === 'Delayed' ? 'delivery_overdue' : 'delivery_received',
        title: `Delivery ${delivery.delivery_number} is ${status.toLowerCase()}`,
        message: `${delivery.po_number}: ${remarks || status}`,
        link: `/deliveries/${deliveryId}`, referenceType: 'delivery', referenceId: deliveryId
      });
    }
  });
}

module.exports = { statuses, openStatuses, validateHeader, validateLines, create, receive, updateStatus };
