async function hasColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS column_count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0].column_count) > 0;
}

async function ensureTimestampColumns(connection, table) {
  for (const column of ['created_at', 'updated_at']) {
    if (await hasColumn(connection, table, column)) continue;
    const updateClause = column === 'updated_at'
      ? ' ON UPDATE CURRENT_TIMESTAMP'
      : '';
    await connection.query(
      `ALTER TABLE ${table} ADD COLUMN ${column} TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP${updateClause}`
    );
  }
}

async function ensureOrderTotalPrecision(connection) {
  const [columns] = await connection.execute(
    `SELECT NUMERIC_PRECISION AS precision_value
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'purchase_orders'
       AND COLUMN_NAME = 'total_cost'`
  );
  if (columns.length && Number(columns[0].precision_value) < 12) {
    await connection.query(
      'ALTER TABLE purchase_orders MODIFY COLUMN total_cost DECIMAL(12, 2) NOT NULL'
    );
  }
}

async function up(connection) {
  await ensureTimestampColumns(connection, 'suppliers');
  await ensureTimestampColumns(connection, 'purchase_orders');
  await ensureOrderTotalPrecision(connection);
}

module.exports = { up };
