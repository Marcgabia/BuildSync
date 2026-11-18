const { fail } = require('../lib/validate');
const notifications = require('./notifications');

/**
 * Changes a product's stock inside the caller's transaction, writes the
 * inventory movement, and raises a low-stock alert when the balance falls to or
 * below the minimum. Stock can never go negative (checked here and by a DB CHECK).
 * A (referenceType, referenceId) pair can only be posted once (UNIQUE index).
 */
async function postMovement(connection, {
  productId, quantity, type, referenceType = null, referenceId = null, notes = null, userId = null
}) {
  const [rows] = await connection.execute(
    'SELECT id, name, product_code, current_stock, minimum_stock FROM products WHERE id = ? FOR UPDATE',
    [productId]
  );
  const product = rows[0];
  if (!product) fail('The selected product no longer exists.');
  const balance = Number(product.current_stock) + Number(quantity);
  if (balance < 0) {
    fail(`Not enough stock for ${product.name}: ${product.current_stock} available, ${Math.abs(quantity)} requested.`);
  }
  await connection.execute('UPDATE products SET current_stock = ? WHERE id = ?', [balance, productId]);
  await connection.execute(
    `INSERT INTO inventory_transactions
      (product_id, transaction_type, quantity, balance_after, reference_type, reference_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, type, quantity, balance, referenceType, referenceId, notes, userId]
  );

  const minimum = Number(product.minimum_stock);
  if (minimum > 0 && balance <= minimum) {
    await notifyLowStock(connection, { ...product, current_stock: balance });
  }
  return balance;
}

async function notifyLowStock(connection, product) {
  // One alert per product per day; a new day produces a fresh reminder.
  const day = new Date().toISOString().slice(0, 10);
  await notifications.notifyPermission(connection, ['inventory.manage', 'purchase_orders.manage'], {
    type: 'low_stock',
    title: `Low stock: ${product.name}`,
    message: `${product.product_code} has ${product.current_stock} on hand (minimum ${product.minimum_stock}).`,
    link: `/products/${product.id}`,
    referenceType: 'product',
    referenceId: product.id,
    dedupeKey: `low_stock:${product.id}:${day}`
  });
}

module.exports = { postMovement, notifyLowStock };
