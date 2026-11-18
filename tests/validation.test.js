const assert = require('node:assert/strict');
const test = require('node:test');
const { validateSupplier } = require('../controllers/supplierController');
const { validatePurchaseOrder } = require('../controllers/purchaseOrderController');

const validSupplier = {
  supplier_code: 'SUP-001',
  vendor_name: 'North Supply',
  key_account_manager: 'Alex Santos',
  contact_number: '+63 912 345 6789',
  email: 'alex@example.test',
  warehouse_address: 'Calapan City',
  material_category: 'Building materials',
  credit_terms: '30',
  delivery_lead_time: '7'
};

const validOrder = {
  po_number: 'PO-2026-001',
  supplier_id: '1',
  item_sku: 'CEMENT-40',
  description: '40 bags of cement',
  quantity_ordered: '40',
  unit_cost: '250.25',
  target_date: '2026-12-01'
};

test('supplier validation accepts a complete profile and normalizes numbers', () => {
  const result = validateSupplier(validSupplier);

  assert.equal(result.error, undefined);
  assert.equal(result.values.credit_terms, 30);
  assert.equal(result.values.delivery_lead_time, 7);
});

test('supplier validation rejects missing fields, invalid email, and negative terms', () => {
  assert.match(validateSupplier({ credit_terms: '', delivery_lead_time: '' }).error, /credit terms/i);
  assert.match(validateSupplier({ ...validSupplier, email: 'not-an-email' }).error, /valid email/i);
  assert.match(validateSupplier({ ...validSupplier, credit_terms: '-1' }).error, /Credit terms/i);
});

test('purchase order validation normalizes money for exact-cent totals', () => {
  const result = validatePurchaseOrder(validOrder);

  assert.equal(result.error, undefined);
  assert.equal(result.values.supplier_id, 1);
  assert.equal(result.values.unit_cost, 250.25);
  assert.equal(result.values.total_cost, 10010);
});

test('purchase order validation rejects bad dates, amounts, and quantities', () => {
  assert.match(validatePurchaseOrder({ ...validOrder, target_date: '2026-02-30' }).error, /valid target date/);
  assert.match(validatePurchaseOrder({ ...validOrder, unit_cost: '1.239' }).error, /Unit cost/);
  assert.match(validatePurchaseOrder({ ...validOrder, quantity_ordered: '0' }).error, /Quantity/);
});
