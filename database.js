const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./buildsync.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to BuildSync SQLite database.');
    
    // Create Suppliers Table
    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_code TEXT UNIQUE,
      vendor_name TEXT,
      key_account_manager TEXT,
      contact_number TEXT,
      email TEXT,
      warehouse_address TEXT,
      material_category TEXT,
      credit_terms INTEGER,
      delivery_lead_time INTEGER,
      status TEXT DEFAULT 'Pending Qualification'
    )`);

    // Create Purchase Orders Table
    db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT UNIQUE,
      supplier_id INTEGER,
      item_sku TEXT,
      description TEXT,
      quantity_ordered INTEGER,
      unit_cost REAL,
      total_cost REAL,
      status TEXT DEFAULT 'Draft',
      target_date TEXT,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    )`);
  }
});

module.exports = db;