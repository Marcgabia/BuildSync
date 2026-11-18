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
const testDatabaseName = `buildsync_flow_${process.pid}_${randomBytes(4).toString('hex')}`;
process.env.DATABASE_NAME = testDatabaseName;

const database = require('../database');
const { migrate } = require('../migrations/runner');
const { app } = require('../server');
const { createUser, Client, startServer, stopServer } = require('./support');

let adminConnection;
let db;
let server;
let baseUrl;
const users = {};
const year = new Date().getFullYear();
const future = `${year + 1}-06-30`;

async function one(sql, params = []) {
  const [rows] = await db.query(sql, params);
  return rows[0];
}

before(async () => {
  adminConnection = await mysql.createConnection(mysqlConfig);
  await adminConnection.query(`CREATE DATABASE \`${testDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  db = await database.initializeDatabase();
  await migrate({ connection: db, logger: { log() {} } });
  await db.query(
    `INSERT INTO suppliers (supplier_code, vendor_name, key_account_manager, contact_number, email, warehouse_address,
       material_category, credit_terms, delivery_lead_time, status)
     VALUES ('FLOW-SUP', 'Flow Supplier', 'Ana', '0917', 'ana@flow.test', 'Calapan', 'Cement', 30, 5, 'Active')`
  );
  for (const [key, roles, department] of [
    ['admin', ['super_admin'], 'ADMIN'], ['requester', ['department_requester'], 'OPS'],
    ['manager', ['purchasing_manager'], 'PROC'], ['officer', ['procurement_officer'], 'PROC'],
    ['warehouse', ['warehouse_staff'], 'WH'], ['finance', ['finance_officer'], 'FIN']
  ]) {
    await createUser(db, { name: `Flow ${key}`, email: `${key}@flow.test`, roles, department });
    users[key] = new Client('');
  }
  ({ server, baseUrl } = await startServer(app));
  for (const [key, client] of Object.entries(users)) {
    client.baseUrl = baseUrl;
    await client.login(`${key}@flow.test`);
  }
});

after(async () => {
  if (server) await stopServer(server);
  if (db) await db.end();
  if (adminConnection) {
    try {
      await adminConnection.query(`DROP DATABASE IF EXISTS \`${testDatabaseName}\``);
    } finally {
      await adminConnection.end();
    }
  }
});

test('permissions are enforced on the server and reflected in navigation', async () => {
  const { requester } = users;
  assert.equal((await requester.get('/suppliers')).status, 403);
  assert.equal((await requester.get('/admin/users')).status, 403);
  assert.equal((await requester.get('/budgets')).status, 403);
  assert.equal((await requester.get('/activity-logs')).status, 403);
  assert.equal((await requester.post('/budgets', { name: 'x' })).status, 403);
  const home = await requester.get('/');
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.text, /href="\/suppliers"/);
  assert.match(home.text, /href="\/requisitions"/);
  const anonymous = await fetch(`${baseUrl}/purchase-orders/1`, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
});

test('full procurement workflow keeps requisitions, orders, inventory, and budgets consistent', async () => {
  const { requester, manager, officer, warehouse, finance, admin } = users;

  // Catalog and budget.
  assert.equal((await officer.post('/products/categories', { name: 'Cement' })).status, 302);
  const category = await one("SELECT id FROM categories WHERE name = 'Cement'");
  const supplier = await one("SELECT id FROM suppliers WHERE supplier_code = 'FLOW-SUP'");
  const productResponse = await officer.post('/products', {
    product_code: 'CEM-40', name: 'Portland cement 40kg', category_id: category.id, unit: 'bag',
    supplier_id: supplier.id, unit_price: '100.00', opening_stock: '2', minimum_stock: '5', status: 'Active'
  });
  assert.equal(productResponse.status, 302);
  const product = await one("SELECT * FROM products WHERE product_code = 'CEM-40'");
  assert.equal(product.current_stock, 2);
  const ops = await one("SELECT id FROM departments WHERE code = 'OPS'");
  assert.equal((await finance.post('/budgets', {
    name: `Operations ${year}`, department_id: ops.id, period_type: 'Annual', fiscal_year: year,
    allocated_amount: '10000', warning_threshold: '80', status: 'Active'
  })).status, 302);
  const budget = await one('SELECT id FROM budgets WHERE department_id = ?', [ops.id]);

  // Requisition: submit, return, resubmit, approve.
  const created = await requester.post('/requisitions', {
    required_date: future, purpose: 'Foundation works', product_id: product.id, quantity: '10', unit_price: '', intent: 'submit'
  });
  assert.equal(created.status, 302);
  const requisition = await one('SELECT * FROM purchase_requisitions ORDER BY id DESC LIMIT 1');
  assert.match(requisition.requisition_number, /^PR-\d{4}-\d{5}$/);
  assert.equal(requisition.status, 'Submitted');
  assert.equal(Number(requisition.total_estimated), 1000);
  assert.equal(Number(requisition.department_id), ops.id);

  const returnWithoutComment = await manager.post(`/approvals/requisitions/${requisition.id}`, { decision: 'return' });
  assert.equal(returnWithoutComment.status, 302);
  assert.equal((await one('SELECT status FROM purchase_requisitions WHERE id = ?', [requisition.id])).status, 'Submitted');
  await manager.post(`/approvals/requisitions/${requisition.id}`, { decision: 'return', comments: 'Add the delivery site' });
  assert.equal((await one('SELECT status FROM purchase_requisitions WHERE id = ?', [requisition.id])).status, 'Returned for Revision');
  const requesterNotes = await one("SELECT COUNT(*) AS total FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'requester@flow.test'");
  assert.ok(Number(requesterNotes.total) >= 1);

  await requester.post(`/requisitions/${requisition.id}/edit`, {
    required_date: future, purpose: 'Foundation works at site B', product_id: product.id, quantity: '10', unit_price: '100', intent: 'submit'
  });
  assert.equal((await one('SELECT status FROM purchase_requisitions WHERE id = ?', [requisition.id])).status, 'Submitted');
  await manager.post(`/approvals/requisitions/${requisition.id}`, { decision: 'approve', comments: 'OK' });
  assert.equal((await one('SELECT status FROM purchase_requisitions WHERE id = ?', [requisition.id])).status, 'Approved');

  // A rejected requisition cannot be converted.
  await requester.post('/requisitions', {
    required_date: future, purpose: 'Not needed', product_id: product.id, quantity: '1', intent: 'submit'
  });
  const rejected = await one('SELECT * FROM purchase_requisitions ORDER BY id DESC LIMIT 1');
  await manager.post(`/approvals/requisitions/${rejected.id}`, { decision: 'reject', comments: 'Duplicate request' });
  const rejectedConversion = await officer.post('/purchase-orders', {
    requisition_id: rejected.id, supplier_id: supplier.id, target_date: future, product_id: product.id, quantity: '1', unit_price: '100', intent: 'draft'
  });
  assert.equal(rejectedConversion.status, 400);
  assert.match(rejectedConversion.text, /Only approved requisitions/);

  // Convert the approved requisition into a PO (12% tax), and block a second conversion.
  const poFields = {
    requisition_id: requisition.id, supplier_id: supplier.id, order_date: `${year}-01-15`, target_date: future,
    product_id: product.id, quantity: '10', unit_price: '100', discount_amount: '0', tax_rate: '12', intent: 'submit'
  };
  assert.equal((await officer.post('/purchase-orders', poFields)).status, 302);
  const order = await one('SELECT * FROM purchase_orders WHERE requisition_id = ?', [requisition.id]);
  assert.match(order.po_number, /^PO-\d{4}-\d{5}$/);
  assert.equal(order.status, 'Pending Approval');
  assert.equal(Number(order.subtotal), 1000);
  assert.equal(Number(order.tax_amount), 120);
  assert.equal(Number(order.total_cost), 1120);
  assert.equal(Number(order.department_id), ops.id);
  assert.equal((await one('SELECT status FROM purchase_requisitions WHERE id = ?', [requisition.id])).status, 'Converted to Purchase Order');
  const duplicate = await officer.post('/purchase-orders', poFields);
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.text, /already been converted/);

  // Approved orders cannot be edited by the officer; the officer cannot self-approve.
  const officerDecision = await officer.post(`/approvals/purchase-orders/${order.id}`, { decision: 'approve' });
  assert.equal(officerDecision.status, 403);
  await manager.post(`/approvals/purchase-orders/${order.id}`, { decision: 'approve' });
  const approved = await one('SELECT * FROM purchase_orders WHERE id = ?', [order.id]);
  assert.equal(approved.status, 'Approved');
  assert.equal(Number(approved.budget_id), Number(budget.id));
  const editLocked = await officer.post(`/purchase-orders/${order.id}/edit`, { ...poFields, intent: 'draft' });
  assert.equal(editLocked.status, 400);
  assert.match(editLocked.text, /Only draft purchase orders can be edited/);

  const balance = async () => one(
    `SELECT COALESCE(SUM(CASE WHEN transaction_type <> 'Actual' THEN amount END), 0) AS committed,
            COALESCE(SUM(CASE WHEN transaction_type = 'Actual' THEN amount END), 0) AS actual
     FROM budget_transactions WHERE budget_id = ?`, [budget.id]
  );
  assert.deepEqual(Object.values(await balance()).map(Number), [1120, 0]);

  // Partial delivery: 4 received, 1 damaged -> 3 accepted.
  const lineId = (await one('SELECT id FROM purchase_order_items WHERE purchase_order_id = ?', [order.id])).id;
  const overReceive = await warehouse.post('/deliveries', {
    purchase_order_id: order.id, intent: 'receive', po_item_id: lineId, received_quantity: '11', damaged_quantity: '0'
  });
  assert.equal(overReceive.status, 400);
  assert.match(overReceive.text, /exceeds the remaining ordered quantity/);

  assert.equal((await warehouse.post('/deliveries', {
    purchase_order_id: order.id, reference_number: 'DR-1001', intent: 'receive',
    po_item_id: lineId, received_quantity: '4', damaged_quantity: '1', line_remarks: 'One torn bag'
  })).status, 302);
  assert.equal((await one('SELECT status FROM purchase_orders WHERE id = ?', [order.id])).status, 'Partially Received');
  assert.equal((await one('SELECT current_stock FROM products WHERE id = ?', [product.id])).current_stock, 5);
  assert.deepEqual(Object.values(await balance()).map(Number), [784, 336]);
  const firstDelivery = await one("SELECT * FROM deliveries WHERE reference_number = 'DR-1001'");
  assert.equal(firstDelivery.status, 'Partially Received');

  // Confirmed deliveries cannot be received twice; duplicate supplier references are rejected.
  const again = await warehouse.post(`/deliveries/${firstDelivery.id}/receive`, {
    po_item_id: lineId, received_quantity: '1', damaged_quantity: '0'
  });
  assert.equal(again.status, 302);
  assert.match((await warehouse.flashAfter(again)).message, /cannot be received twice/);
  const duplicateRef = await warehouse.post('/deliveries', {
    purchase_order_id: order.id, reference_number: 'DR-1001', intent: 'schedule', status: 'In Transit'
  });
  assert.equal(duplicateRef.status, 400);

  // Scheduled delivery, then receive the remaining 7.
  assert.equal((await warehouse.post('/deliveries', {
    purchase_order_id: order.id, reference_number: 'DR-1002', intent: 'schedule', status: 'In Transit'
  })).status, 302);
  const scheduled = await one("SELECT * FROM deliveries WHERE reference_number = 'DR-1002'");
  assert.equal(scheduled.status, 'In Transit');
  await warehouse.post(`/deliveries/${scheduled.id}/receive`, { po_item_id: lineId, received_quantity: '7', damaged_quantity: '0' });
  assert.equal((await one('SELECT status FROM purchase_orders WHERE id = ?', [order.id])).status, 'Completed');
  assert.equal((await one('SELECT status FROM deliveries WHERE id = ?', [scheduled.id])).status, 'Fully Received');
  assert.equal((await one('SELECT current_stock FROM products WHERE id = ?', [product.id])).current_stock, 12);
  assert.deepEqual(Object.values(await balance()).map(Number), [0, 1120]);
  const receipts = await one("SELECT COUNT(*) AS total FROM inventory_transactions WHERE product_id = ? AND transaction_type = 'Receipt'", [product.id]);
  assert.equal(Number(receipts.total), 2);

  // Stock can never go negative.
  const tooMuch = await warehouse.post(`/products/${product.id}/adjust`, { type: 'Adjustment Out', quantity: '13', notes: 'Count' });
  assert.match((await warehouse.flashAfter(tooMuch)).message, /Not enough stock/);
  assert.equal((await one('SELECT current_stock FROM products WHERE id = ?', [product.id])).current_stock, 12);
  await warehouse.post(`/products/${product.id}/adjust`, { type: 'Adjustment Out', quantity: '8', notes: 'Issued to site' });
  assert.equal((await one('SELECT current_stock FROM products WHERE id = ?', [product.id])).current_stock, 4);
  const lowStockAlert = await one("SELECT COUNT(*) AS total FROM notifications WHERE type = 'low_stock'");
  assert.ok(Number(lowStockAlert.total) >= 1);

  // Over-budget approval is blocked by policy; cancellation releases commitments.
  const bigOrder = await officer.post('/purchase-orders', {
    supplier_id: supplier.id, department_id: ops.id, order_date: `${year}-02-01`, target_date: future,
    product_id: product.id, quantity: '200', unit_price: '100', tax_rate: '0', intent: 'submit'
  });
  assert.equal(bigOrder.status, 302);
  const big = await one('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT 1');
  const blocked = await manager.post(`/approvals/purchase-orders/${big.id}`, { decision: 'approve' });
  assert.match((await manager.flashAfter(blocked)).message, /exceeds the remaining/);
  assert.equal((await one('SELECT status FROM purchase_orders WHERE id = ?', [big.id])).status, 'Pending Approval');

  await officer.post('/purchase-orders', {
    supplier_id: supplier.id, department_id: ops.id, order_date: `${year}-02-02`, target_date: future,
    product_id: product.id, quantity: '5', unit_price: '100', tax_rate: '0', intent: 'submit'
  });
  const small = await one('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT 1');
  await manager.post(`/approvals/purchase-orders/${small.id}`, { decision: 'approve' });
  assert.deepEqual(Object.values(await balance()).map(Number), [500, 1120]);
  await manager.post(`/purchase-orders/${small.id}/cancel`, { reason: 'Supplier out of stock' });
  assert.equal((await one('SELECT status FROM purchase_orders WHERE id = ?', [small.id])).status, 'Cancelled');
  assert.deepEqual(Object.values(await balance()).map(Number), [0, 1120]);

  // Audit trail, reports, exports, and dashboard.
  const logs = await one("SELECT COUNT(*) AS total FROM activity_logs WHERE module IN ('Approvals', 'Deliveries', 'Inventory', 'Budgets')");
  assert.ok(Number(logs.total) >= 8);
  const logPage = await admin.get('/activity-logs?module=Approvals');
  assert.equal(logPage.status, 200);
  assert.match(logPage.text, /approved purchase order/);
  const report = await manager.get('/reports/po-by-status');
  assert.equal(report.status, 200);
  assert.match(report.text, /Completed/);
  const csv = await fetch(`${baseUrl}/reports/budget-utilization?format=csv`, { headers: { Cookie: manager.cookieHeader() } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Operations/);
  const dashboard = await admin.get('/');
  assert.match(dashboard.text, /Monthly procurement expenses/);
  assert.match(dashboard.text, /Upcoming deliveries/);
  const print = await officer.get(`/purchase-orders/${order.id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.text, /Purchase Order/);
});

test('users, roles, notifications, and sessions are managed securely', async () => {
  const { admin, requester } = users;
  const role = await one("SELECT id FROM roles WHERE role_key = 'department_requester'");
  const created = await admin.post('/admin/users', {
    full_name: 'New Clerk', email: 'clerk@flow.test', password: 'Temporary-pass-1', role_ids: role.id, status: 'Active'
  });
  assert.equal(created.status, 302);
  const clerkRow = await one("SELECT * FROM users WHERE email = 'clerk@flow.test'");
  assert.match(clerkRow.password_hash, /^scrypt\$/);
  assert.equal(clerkRow.must_change_password, 1);

  const clerk = new Client(baseUrl);
  await clerk.get('/login');
  await clerk.post('/login', { email: 'clerk@flow.test', password: 'Temporary-pass-1' });
  const forced = await clerk.get('/requisitions');
  assert.equal(forced.status, 302);
  assert.equal(forced.location, '/account/password');
  await clerk.get('/account/password');
  const changed = await clerk.post('/account/password', {
    current_password: 'Temporary-pass-1', password: 'Brand-new-pass-2', password_confirmation: 'Brand-new-pass-2'
  });
  assert.equal(changed.status, 302);
  assert.equal((await clerk.get('/requisitions')).status, 200);

  // Deactivating a user ends their session immediately.
  await admin.post(`/admin/users/${clerkRow.id}/toggle`);
  assert.equal((await one('SELECT status FROM users WHERE id = ?', [clerkRow.id])).status, 'Inactive');
  assert.equal((await clerk.get('/requisitions')).status, 302);

  // Custom role with selected permissions.
  const viewSuppliers = await one("SELECT id FROM permissions WHERE permission_key = 'suppliers.view'");
  await admin.post('/admin/roles', { name: 'Auditor', description: 'Read-only', permission_ids: [viewSuppliers.id], is_active: '1' });
  const auditor = await one("SELECT * FROM roles WHERE name = 'Auditor'");
  assert.ok(auditor);
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM role_permissions WHERE role_id = ?', [auditor.id])).total), 1);

  // Notifications: mark all as read.
  const before = await one("SELECT COUNT(*) AS total FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'requester@flow.test' AND is_read = 0");
  assert.ok(Number(before.total) > 0);
  await requester.get('/notifications');
  await requester.post('/notifications/read-all');
  const afterRead = await one("SELECT COUNT(*) AS total FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'requester@flow.test' AND is_read = 0");
  assert.equal(Number(afterRead.total), 0);

  // Wrong password is rejected and audited; activity logs have no modify/delete route.
  const stranger = new Client(baseUrl);
  await stranger.get('/login');
  const failed = await stranger.post('/login', { email: 'admin@flow.test', password: 'wrong-password-1' });
  assert.equal(failed.status, 401);
  assert.equal((await admin.post('/activity-logs/1/delete')).status, 404);

  // Logout destroys the session.
  await requester.post('/logout');
  assert.equal((await requester.get('/requisitions')).status, 302);
});

test('every module page renders for an administrator', async () => {
  const { admin } = users;
  const ids = {
    product: (await one('SELECT id FROM products LIMIT 1')).id,
    category: (await one('SELECT id FROM categories LIMIT 1')).id,
    requisition: (await one('SELECT id FROM purchase_requisitions LIMIT 1')).id,
    order: (await one("SELECT id FROM purchase_orders WHERE status = 'Completed' LIMIT 1")).id,
    draft: (await one("SELECT id FROM purchase_orders WHERE status = 'Pending Approval' LIMIT 1")).id,
    delivery: (await one('SELECT id FROM deliveries LIMIT 1')).id,
    budget: (await one('SELECT id FROM budgets LIMIT 1')).id,
    supplier: (await one('SELECT id FROM suppliers LIMIT 1')).id,
    user: (await one('SELECT id FROM users LIMIT 1')).id,
    role: (await one('SELECT id FROM roles LIMIT 1')).id
  };
  const { reports } = require('../models/report');
  const pages = [
    '/', '/suppliers', `/suppliers/${ids.supplier}`, `/suppliers/${ids.supplier}/edit`,
    '/products', '/products?low=1', `/products/${ids.product}`, `/products/${ids.product}/edit`,
    '/products/categories', `/products/categories/${ids.category}/edit`, '/inventory',
    '/requisitions', '/requisitions?scope=mine', '/requisitions/new', `/requisitions/${ids.requisition}`,
    '/approvals', '/purchase-orders', '/purchase-orders?status=Completed', '/purchase-orders/new',
    `/purchase-orders/new?requisition=${ids.requisition}`, `/purchase-orders/${ids.order}`, `/purchase-orders/${ids.order}/print`,
    `/purchase-orders/${ids.draft}`, '/deliveries', '/deliveries/new', `/deliveries/new?po=${ids.draft}`, `/deliveries/${ids.delivery}`,
    '/budgets', `/budgets/${ids.budget}`, `/budgets/${ids.budget}/edit`, '/reports',
    ...Object.keys(reports).map((key) => `/reports/${key}?from=${year}-01-01&to=${year + 1}-12-31`),
    ...Object.keys(reports).map((key) => `/reports/${key}?format=print`),
    '/notifications', '/notifications?state=unread', '/activity-logs', '/admin/users', '/admin/users/new',
    `/admin/users/${ids.user}/edit`, '/admin/roles', '/admin/roles/new', `/admin/roles/${ids.role}/edit`, '/settings',
    '/account/password', '/purchase-orders/export.csv', '/products/export.csv', '/deliveries/export.csv',
    '/budgets/export.csv', '/activity-logs/export.csv'
  ];
  for (const page of pages) {
    const response = await admin.get(page);
    assert.ok([200, 302].includes(response.status), `${page} returned ${response.status}`);
    assert.doesNotMatch(response.text, /Something went wrong/, page);
  }
  assert.equal((await admin.get('/does-not-exist')).status, 404);
  assert.equal((await admin.get('/purchase-orders/999999')).status, 404);
});

test('visitors can create an account from the sign-in page with least-privilege access', async () => {
  const { admin } = users;
  const visitor = new Client(baseUrl);
  const loginPage = await visitor.get('/login');
  assert.match(loginPage.text, /href="\/register"/);
  assert.equal((await visitor.get('/register')).status, 200);
  const ops = await one("SELECT id FROM departments WHERE code = 'OPS'");
  const fields = {
    full_name: 'Self Registered', email: 'self@flow.test', department_id: ops.id,
    password: 'Register-pass-1', password_confirmation: 'Register-pass-1', terms: 'accepted'
  };

  // Default policy: account is created Pending and cannot sign in yet.
  const mismatch = await visitor.post('/register', { ...fields, password_confirmation: 'Different-pass-1' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.text, /do not match/);
  const registered = await visitor.post('/register', fields);
  assert.equal(registered.status, 201);
  assert.match(registered.text, /awaiting|review/i);
  const row = await one("SELECT u.*, r.role_key FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.email = 'self@flow.test'");
  assert.equal(row.status, 'Pending');
  assert.equal(row.role_key, 'department_requester');
  assert.match(row.password_hash, /^scrypt\$/);
  const duplicate = await visitor.post('/register', fields);
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.text, /already exists/);
  const pendingLogin = await visitor.post('/login', { email: 'self@flow.test', password: 'Register-pass-1' });
  assert.equal(pendingLogin.status, 403);
  assert.match(pendingLogin.text, /awaiting administrator approval/);
  const adminNote = await one("SELECT COUNT(*) AS total FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@flow.test' AND n.title LIKE 'New account awaiting approval%'");
  assert.equal(Number(adminNote.total), 1);

  // Administrator approves; the user can sign in with requester permissions only.
  await admin.post(`/admin/users/${row.id}/toggle`);
  assert.equal((await one('SELECT status FROM users WHERE id = ?', [row.id])).status, 'Active');
  const member = new Client(baseUrl);
  await member.login('self@flow.test', 'Register-pass-1');
  assert.equal((await member.get('/requisitions/new')).status, 200);
  assert.equal((await member.get('/admin/users')).status, 403);
  assert.equal((await member.get('/suppliers')).status, 403);

  // Open registration signs the user in immediately; disabled registration is refused.
  await admin.get('/settings');
  await admin.post('/settings', { self_registration: 'open' });
  const openVisitor = new Client(baseUrl);
  await openVisitor.get('/register');
  const openResult = await openVisitor.post('/register', { ...fields, email: 'open@flow.test' });
  assert.equal(openResult.status, 302);
  assert.equal((await openVisitor.get('/requisitions')).status, 200);
  assert.equal((await admin.post('/settings', { self_registration_role: 'super_admin' })).status, 302);
  assert.equal((await one("SELECT setting_value FROM settings WHERE setting_key = 'self_registration_role'")).setting_value, 'department_requester');
  await admin.post('/settings', { self_registration: 'disabled' });
  const closed = new Client(baseUrl);
  assert.doesNotMatch((await closed.get('/login')).text, /href="\/register"/);
  assert.equal((await closed.get('/register')).status, 403);
  assert.equal((await closed.post('/register', { ...fields, email: 'blocked@flow.test' })).status, 403);
  assert.equal(await one("SELECT id FROM users WHERE email = 'blocked@flow.test'"), undefined);
  await admin.post('/settings', { self_registration: 'approval' });
});

test('theme preference and password visibility controls render correctly', async () => {
  // No saved preference: no data-theme attribute, so the operating-system setting applies.
  const plain = await fetch(`${baseUrl}/login`);
  const plainHtml = await plain.text();
  assert.match(plainHtml, /<html lang="en">/);
  assert.match(plainHtml, /js-theme-toggle/);
  // Saved preference cookie is rendered server-side (no flash of the wrong theme).
  for (const theme of ['dark', 'light']) {
    const page = await fetch(`${baseUrl}/login`, { headers: { Cookie: `buildsync_theme=${theme}` } });
    assert.match(await page.text(), new RegExp(`<html lang="en" data-theme="${theme}">`));
  }
  const bogus = await fetch(`${baseUrl}/login`, { headers: { Cookie: 'buildsync_theme="><script>' } });
  assert.match(await bogus.text(), /<html lang="en">/);
  const signedIn = await users.admin.get('/');
  assert.match(signedIn.text, /js-theme-toggle/);

  // Every password input has a Show/Hide button that is outside its <label> and points at the input.
  for (const path of ['/login', '/register']) {
    const html = await (await fetch(`${baseUrl}${path}`)).text();
    const inputs = [...html.matchAll(/<input id="([\w-]+)" name="[\w_]+" type="password"/g)].map((m) => m[1]);
    assert.ok(inputs.length >= 1, `${path} has password inputs`);
    for (const id of inputs) {
      assert.match(html, new RegExp(`class="password-toggle js-toggle-password" type="button" aria-controls="${id}"`));
    }
    assert.doesNotMatch(html, /<label[^>]*>(?:(?!<\/label>)[\s\S])*js-toggle-password/);
  }
  const scriptRef = (await (await fetch(`${baseUrl}/login`)).text()).match(/src="(\/app\.js\?v=\d+)"/);
  assert.ok(scriptRef, 'app.js is referenced with a cache-busting version');
  const script = await (await fetch(`${baseUrl}${scriptRef[1]}`)).text();
  assert.match(script, /js-toggle-password/);
  assert.match(script, /buildsync_theme=/);
});
