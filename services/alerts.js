const { pool } = require('../lib/db');
const notifications = require('./notifications');
const inventory = require('./inventory');
const budget = require('./budget');
const settings = require('./settings');

/**
 * Scans for time-based alerts (upcoming/overdue deliveries, low stock, budget
 * thresholds). Notifications use dedupe keys, so repeated scans never spam.
 */
async function scan() {
  const connection = pool();
  const days = await settings.getNumber('upcoming_delivery_days');
  const recipients = ['purchase_orders.manage', 'deliveries.manage'];

  const [upcoming] = await connection.execute(
    `SELECT po.id, po.po_number, po.target_date, s.vendor_name FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.status IN ('Approved', 'Ordered', 'Partially Received')
       AND po.target_date BETWEEN CURDATE() AND CURDATE() + INTERVAL ? DAY`,
    [days]
  );
  for (const order of upcoming) {
    await notifications.notifyPermission(connection, recipients, {
      type: 'delivery_upcoming',
      title: `Delivery due ${order.target_date}: ${order.po_number}`,
      message: `${order.vendor_name} is expected to deliver ${order.po_number} on ${order.target_date}.`,
      link: `/purchase-orders/${order.id}`, referenceType: 'purchase_order', referenceId: order.id,
      dedupeKey: `po_upcoming:${order.id}:${order.target_date}`
    });
  }

  const [overdue] = await connection.execute(
    `SELECT po.id, po.po_number, po.target_date, s.vendor_name FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.status IN ('Approved', 'Ordered', 'Partially Received') AND po.target_date < CURDATE()`
  );
  for (const order of overdue) {
    await notifications.notifyPermission(connection, recipients, {
      type: 'delivery_overdue',
      title: `Overdue delivery: ${order.po_number}`,
      message: `${order.vendor_name} has not completed ${order.po_number}, which was due ${order.target_date}.`,
      link: `/purchase-orders/${order.id}`, referenceType: 'purchase_order', referenceId: order.id,
      dedupeKey: `po_overdue:${order.id}:${order.target_date}`
    });
  }

  const [lowStock] = await connection.execute(
    `SELECT id, name, product_code, current_stock, minimum_stock FROM products
     WHERE status = 'Active' AND minimum_stock > 0 AND current_stock <= minimum_stock`
  );
  for (const product of lowStock) await inventory.notifyLowStock(connection, product);

  const [budgets] = await connection.execute("SELECT id FROM budgets WHERE status = 'Active'");
  for (const row of budgets) await budget.checkThreshold(connection, row.id);
}

function start(intervalMs = 15 * 60 * 1000) {
  const run = () => scan().catch((error) => console.warn('Alert scan failed:', error.message));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { scan, start };
