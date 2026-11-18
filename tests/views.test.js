const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const viewsDirectory = path.join(__dirname, '..', 'views');

function render(view, locals) {
  return ejs.renderFile(path.join(viewsDirectory, view), locals);
}

test('dashboard renders empty procurement metrics and navigation', async () => {
  const html = await render('layout.ejs', {
    supplierCounts: { total: 0, active: 0 },
    orderCounts: { total: 0, awaiting_approval: 0, committed: 0 },
    recentOrders: [],
    csrfToken: 'a'.repeat(64)
  });

  assert.match(html, /Procurement, in sync\./);
  assert.match(html, /Your procurement activity starts here/);
  assert.match(html, /<aside class="sidebar"/);
  assert.match(html, /href="\/styles\.css\?v=5"/);
  assert.match(html, /class="theme-toggle js-theme-toggle"/);
  assert.match(html, /aria-label="Primary navigation"/);
  assert.match(html, /href="\/" aria-current="page"/);
  assert.match(html, /href="\/purchase-orders"/);
});

test('supplier directory renders escaped supplier data and search', async () => {
  const html = await render('suppliers.ejs', {
    suppliers: [{
      id: 1,
      supplier_code: 'SUP-001',
      vendor_name: '<script>alert(1)</script>',
      key_account_manager: 'Alex',
      email: 'alex@example.test',
      material_category: 'Building materials',
      credit_terms: 30,
      delivery_lead_time: 7,
      status: 'Active'
    }],
    search: '',
    error: null,
    formValues: {},
    success: null,
    csrfToken: 'a'.repeat(64)
  });

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Add a supplier/);
  assert.match(html, /href="\/suppliers" aria-current="page"/);
});

test('purchase order view renders supplier selector and empty state', async () => {
  const html = await render('purchase-orders.ejs', {
    orders: [],
    suppliers: [{ id: 1, supplier_code: 'SUP-001', vendor_name: 'North Supply' }],
    statuses: ['Draft', 'Pending Approval'],
    error: null,
    formValues: {},
    success: null,
    csrfToken: 'a'.repeat(64)
  });

  assert.match(html, /No purchase orders yet/);
  assert.match(html, /North Supply/);
  assert.match(html, /Create purchase order/);
  assert.match(html, /href="\/purchase-orders" aria-current="page"/);
});

test('error view renders a safe recovery link', async () => {
  const html = await render('error.ejs', {
    title: 'Page not found',
    message: 'The page does not exist.'
  });

  assert.match(html, /Page not found/);
  assert.match(html, /Return to overview/);
});
