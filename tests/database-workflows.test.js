const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { after, before, test } = require('node:test');

const mysqlConfig = {
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 3306),
  user: process.env.DATABASE_USER || 'root',
  password: process.env.DATABASE_PASSWORD || '',
  connectTimeout: 5000
};
const testDatabaseName = `buildsync_test_${process.pid}_${randomBytes(4).toString('hex')}`;
process.env.DATABASE_NAME = testDatabaseName;

const database = require('../database');
const { migrate, listMigrations } = require('../migrations/runner');
const Supplier = require('../models/supplier');
const PurchaseOrder = require('../models/purchaseOrder');
const SupplierFactory = require('../factories/supplierFactory');
const PurchaseOrderFactory = require('../factories/purchaseOrderFactory');
const { seed } = require('../seeders');
const { app } = require('../server');
const { createUser, Client, startServer, stopServer } = require('./support');

let adminConnection;
let connection;

before(async () => {
  adminConnection = await mysql.createConnection(mysqlConfig);
  await adminConnection.query(
    `CREATE DATABASE \`${testDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  connection = await database.initializeDatabase();
});

after(async () => {
  if (connection) await connection.end();
  if (adminConnection) {
    try {
      await adminConnection.query(`DROP DATABASE IF EXISTS \`${testDatabaseName}\``);
    } finally {
      await adminConnection.end();
    }
  }
});

test('versioned MySQL migrations are applied once and tracked', async () => {
  const firstRun = await migrate({ connection, logger: { log() {} } });
  const secondRun = await migrate({ connection, logger: { log() {} } });
  const [rows] = await connection.query('SELECT migration FROM schema_migrations ORDER BY migration');
  const expected = listMigrations().map((migration) => migration.name);

  assert.deepEqual(firstRun.slice(0, 3), [
    '001_create_suppliers.js',
    '002_create_purchase_orders.js',
    '003_add_audit_columns.js'
  ]);
  assert.deepEqual(firstRun, expected);
  assert.deepEqual(secondRun, []);
  assert.equal(rows.length, expected.length);
});

test('MySQL migrations upgrade existing records without deleting them', async () => {
  const legacyDatabaseName = `buildsync_legacy_${process.pid}_${randomBytes(4).toString('hex')}`;
  await adminConnection.query(
    `CREATE DATABASE \`${legacyDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  const legacyConnection = mysql.createPool({ ...mysqlConfig, database: legacyDatabaseName });

  try {
    await legacyConnection.query(`
      CREATE TABLE suppliers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        supplier_code VARCHAR(50) UNIQUE,
        vendor_name VARCHAR(255),
        key_account_manager VARCHAR(255),
        contact_number VARCHAR(50),
        email VARCHAR(255),
        warehouse_address TEXT,
        material_category VARCHAR(255),
        credit_terms INT,
        delivery_lead_time INT,
        status VARCHAR(50) DEFAULT 'Pending Qualification'
      )
    `);
    await legacyConnection.query(`
      CREATE TABLE purchase_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        po_number VARCHAR(50) UNIQUE,
        supplier_id INT,
        item_sku VARCHAR(100),
        description TEXT,
        quantity_ordered INT,
        unit_cost DECIMAL(10, 2),
        total_cost DECIMAL(10, 2),
        status VARCHAR(50) DEFAULT 'Draft',
        target_date DATE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
      )
    `);
    const [supplierInsert] = await legacyConnection.execute(
      `INSERT INTO suppliers
        (supplier_code, vendor_name, key_account_manager, contact_number, email,
         warehouse_address, material_category, credit_terms, delivery_lead_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['LEGACY-001', 'Legacy Supplier', 'Alex', '09170000000',
        'alex@example.test', 'Calapan', 'Hardware', 30, 7]
    );
    await legacyConnection.execute(
      `INSERT INTO purchase_orders (po_number, supplier_id, item_sku, description, quantity_ordered, unit_cost, total_cost, status, target_date)
       VALUES ('LEGACY-PO-1', ?, 'SKU-1', 'Legacy order', 4, 10.50, 42.00, 'Received', '2026-01-10')`,
      [supplierInsert.insertId]
    );

    await migrate({ connection: legacyConnection, logger: { log() {} } });
    const [supplierRows] = await legacyConnection.execute(
      'SELECT supplier_code, created_at, updated_at FROM suppliers WHERE supplier_code = ?',
      ['LEGACY-001']
    );

    assert.equal(supplierRows.length, 1);
    assert.ok(supplierRows[0].created_at);
    assert.ok(supplierRows[0].updated_at);

    const [orderColumns] = await legacyConnection.execute(
      `SELECT NUMERIC_PRECISION AS precision_value
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchase_orders' AND COLUMN_NAME = 'total_cost'`,
      [legacyDatabaseName]
    );
    assert.ok(Number(orderColumns[0].precision_value) >= 12);

    // Existing orders are preserved: copied into line items and the legacy status renamed.
    const [[legacyOrder]] = await legacyConnection.query("SELECT * FROM purchase_orders WHERE po_number = 'LEGACY-PO-1'");
    assert.equal(legacyOrder.status, 'Completed');
    assert.equal(Number(legacyOrder.subtotal), 42);
    const [legacyItems] = await legacyConnection.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?', [legacyOrder.id]);
    assert.equal(legacyItems.length, 1);
    assert.equal(legacyItems[0].item_code, 'SKU-1');
    assert.equal(Number(legacyItems[0].received_quantity), 4);
  } finally {
    await legacyConnection.end();
    await adminConnection.query(`DROP DATABASE IF EXISTS \`${legacyDatabaseName}\``);
  }
});

test('factories create related domain records through the models', async () => {
  const supplierModel = new Supplier();
  const orderModel = new PurchaseOrder();
  const supplierFactory = new SupplierFactory(supplierModel);
  const orderFactory = new PurchaseOrderFactory(orderModel);

  const supplier = await supplierFactory.create({ supplier_code: 'FACTORY-SUP-1' });
  const order = await orderFactory.create({
    supplier_id: supplier.id,
    po_number: 'FACTORY-PO-1'
  });

  assert.equal(supplier.vendor_name.includes('Sample Building Supply'), true);
  assert.equal(order.supplier_id, supplier.id);
  assert.equal(order.total_cost, 1255);
  assert.equal(Number((await supplierModel.counts()).total), 1);
  const detail = await orderModel.findDetail(order.id);
  assert.equal(detail.items.length, 1);
});

test('seed data is useful on first run and idempotent on later runs', async () => {
  const firstRun = await seed();
  const secondRun = await seed();
  const supplierModel = new Supplier();
  const orderModel = new PurchaseOrder();

  assert.deepEqual(firstRun, { suppliers: 3, purchaseOrders: 2 });
  assert.deepEqual(secondRun, { suppliers: 0, purchaseOrders: 0 });
  assert.equal(Number((await supplierModel.counts()).total), 4);
  assert.equal(Number((await orderModel.counts()).total), 3);
  assert.equal((await orderModel.all()).length, 3);
});

test('factories reject invalid batch sizes', () => {
  const supplierFactory = new SupplierFactory();
  const orderFactory = new PurchaseOrderFactory();
  const customizedOrder = orderFactory.build({ quantity_ordered: 4, unit_cost: 12.5 });

  assert.throws(() => supplierFactory.buildMany(-1), RangeError);
  assert.throws(() => orderFactory.buildMany(1.5), RangeError);
  assert.notEqual(supplierFactory.build().supplier_code, supplierFactory.build().supplier_code);
  assert.equal(customizedOrder.total_cost, 50);
});

test('controllers serve MySQL-backed supplier, order, and dashboard workflows', async () => {
  const { server, baseUrl } = await startServer(app);
  await createUser(connection, { name: 'Test Officer', email: 'officer@example.test', roles: ['procurement_officer'] });
  await createUser(connection, { name: 'Test Manager', email: 'manager@example.test', roles: ['purchasing_manager'] });
  const officer = new Client(baseUrl);
  const manager = new Client(baseUrl);

  try {
    const anonymous = await fetch(`${baseUrl}/suppliers`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('location'), /^\/login/);

    await officer.login('officer@example.test');
    await manager.login('manager@example.test');

    const [dashboard, suppliers, purchaseOrders] = await Promise.all([
      officer.get('/'),
      officer.get('/suppliers'),
      officer.get('/purchase-orders')
    ]);

    assert.equal(dashboard.status, 200);
    assert.equal(suppliers.status, 200);
    assert.equal(purchaseOrders.status, 200);
    assert.equal(suppliers.headers.get('x-frame-options'), 'DENY');
    assert.equal(suppliers.headers.get('x-content-type-options'), 'nosniff');
    assert.match(suppliers.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(dashboard.text, /Procurement, in sync\./);
    assert.match(suppliers.text, /Mindoro Construction Supply/);
    assert.match(purchaseOrders.text, /DEMO-PO-001/);

    const missingCsrf = await fetch(`${baseUrl}/suppliers/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: officer.cookieHeader() },
      body: new URLSearchParams({ vendor_name: 'Blocked Supplier' }),
      redirect: 'manual'
    });
    assert.equal(missingCsrf.status, 403);

    const supplierFields = {
      supplier_code: 'HTTP-SUP-001',
      vendor_name: 'HTTP Integration Supplier',
      key_account_manager: 'Test Manager',
      contact_number: '+63 917 000 0001',
      email: 'integration@example.test',
      warehouse_address: 'Calapan City',
      material_category: 'Hardware',
      credit_terms: '30',
      delivery_lead_time: '5'
    };
    const createdSupplier = await officer.post('/suppliers/add', supplierFields);
    assert.equal(createdSupplier.status, 302);
    assert.equal(createdSupplier.location, '/suppliers?success=created');

    const duplicateSupplier = await officer.post('/suppliers/add', supplierFields);
    assert.equal(duplicateSupplier.status, 409);
    assert.match(duplicateSupplier.text, /supplier code is already in use/i);

    const supplierRecord = await new Supplier().findByCode('HTTP-SUP-001');
    assert.ok(supplierRecord);
    await officer.get(`/suppliers/${supplierRecord.id}/edit`);
    const supplierUpdate = await officer.post(`/suppliers/${supplierRecord.id}/edit`, {
      ...supplierFields, vendor_name: 'Updated HTTP Integration Supplier', status: 'Active', tax_id: '123-456-789'
    });
    assert.equal(supplierUpdate.status, 302);
    const updatedSupplier = await new Supplier().findById(supplierRecord.id);
    assert.equal(updatedSupplier.vendor_name, 'Updated HTTP Integration Supplier');
    assert.equal(updatedSupplier.tax_id, '123-456-789');

    // Managers can view suppliers but not change them (server-side check).
    const managerEdit = await manager.post(`/suppliers/${supplierRecord.id}/edit`, { ...supplierFields, status: 'Active' });
    assert.equal(managerEdit.status, 403);

    const createdOrder = await officer.post('/purchase-orders/add', {
      po_number: 'HTTP-PO-001',
      supplier_id: String(supplierRecord.id),
      item_sku: 'TEST-001',
      description: 'Integration test order',
      quantity_ordered: '2',
      unit_cost: '12.50',
      target_date: '2027-01-30'
    });
    assert.equal(createdOrder.status, 302);
    assert.equal(createdOrder.location, '/purchase-orders?success=created');

    const createdPurchaseOrder = await new PurchaseOrder().findByNumber('HTTP-PO-001');
    assert.equal(Number(createdPurchaseOrder.total_cost), 25);
    assert.equal(createdPurchaseOrder.status, 'Pending Approval');

    // The legacy status endpoint is governed by the approval workflow.
    const officerApprove = await officer.post(`/purchase-orders/${createdPurchaseOrder.id}/status`, { status: 'Approved' });
    assert.equal(officerApprove.status, 302);
    assert.equal((await new PurchaseOrder().findById(createdPurchaseOrder.id)).status, 'Pending Approval');
    const statusUpdate = await manager.post(`/purchase-orders/${createdPurchaseOrder.id}/status`, { status: 'Approved' });
    assert.equal(statusUpdate.status, 302);
    assert.equal((await new PurchaseOrder().findById(createdPurchaseOrder.id)).status, 'Approved');

    const clientScript = await fetch(`${baseUrl}/app.js`);
    assert.equal(clientScript.status, 200);
    assert.equal(clientScript.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await clientScript.text(), /js-auto-submit/);

    const inactiveSupplier = await new Supplier().findByCode('DEMO-HARDWARE-001');
    const inactiveOrder = await officer.post('/purchase-orders/add', {
      po_number: 'HTTP-PO-INACTIVE',
      supplier_id: String(inactiveSupplier.id),
      item_sku: 'TEST-002',
      description: 'Order for an inactive supplier',
      quantity_ordered: '2',
      unit_cost: '12.50',
      target_date: '2027-01-30'
    });
    assert.equal(inactiveOrder.status, 400);
    assert.match(inactiveOrder.text, /active supplier/i);
    assert.equal(await new PurchaseOrder().findByNumber('HTTP-PO-INACTIVE'), null);
  } finally {
    await stopServer(server);
  }
});
