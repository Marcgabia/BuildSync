async function up(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      po_number VARCHAR(50) NOT NULL UNIQUE,
      supplier_id INT NOT NULL,
      item_sku VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      quantity_ordered INT NOT NULL,
      unit_cost DECIMAL(10, 2) NOT NULL,
      total_cost DECIMAL(12, 2) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Draft',
      target_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_purchase_orders_supplier
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    )
  `);
}

module.exports = { up };
