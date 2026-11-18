async function up(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      supplier_code VARCHAR(50) NOT NULL UNIQUE,
      vendor_name VARCHAR(255) NOT NULL,
      key_account_manager VARCHAR(255) NOT NULL,
      contact_number VARCHAR(50) NOT NULL,
      email VARCHAR(255) NOT NULL,
      warehouse_address TEXT NOT NULL,
      material_category VARCHAR(255) NOT NULL,
      credit_terms INT NOT NULL,
      delivery_lead_time INT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Pending Qualification',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { up };
