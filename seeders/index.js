const Supplier = require('../models/supplier');
const PurchaseOrder = require('../models/purchaseOrder');
const SupplierFactory = require('../factories/supplierFactory');
const PurchaseOrderFactory = require('../factories/purchaseOrderFactory');

const supplierFixtures = [
  {
    supplier_code: 'DEMO-BUILD-001',
    vendor_name: 'Mindoro Construction Supply',
    key_account_manager: 'Maria Santos',
    contact_number: '+63 917 100 0001',
    email: 'maria@mindoro-supply.example',
    warehouse_address: 'Calapan City, Oriental Mindoro',
    material_category: 'Building materials',
    credit_terms: 30,
    delivery_lead_time: 5,
    status: 'Active'
  },
  {
    supplier_code: 'DEMO-ELECTRIC-001',
    vendor_name: 'Island Electrical Traders',
    key_account_manager: 'Jose Reyes',
    contact_number: '+63 917 100 0002',
    email: 'jose@island-electrical.example',
    warehouse_address: 'Naujan, Oriental Mindoro',
    material_category: 'Electrical',
    credit_terms: 15,
    delivery_lead_time: 7,
    status: 'Active'
  },
  {
    supplier_code: 'DEMO-HARDWARE-001',
    vendor_name: 'Central Hub Hardware',
    key_account_manager: 'Ana Cruz',
    contact_number: '+63 917 100 0003',
    email: 'ana@central-hardware.example',
    warehouse_address: 'Victoria, Oriental Mindoro',
    material_category: 'Hardware',
    credit_terms: 30,
    delivery_lead_time: 3,
    status: 'Pending Qualification'
  }
];

const orderFixtures = [
  {
    po_number: 'DEMO-PO-001',
    supplier_code: 'DEMO-BUILD-001',
    item_sku: 'CEMENT-40KG',
    description: 'Portland cement, 40 kg bags',
    quantity_ordered: 100,
    unit_cost: 245,
    status: 'Approved',
    target_date: '2027-01-15'
  },
  {
    po_number: 'DEMO-PO-002',
    supplier_code: 'DEMO-ELECTRIC-001',
    item_sku: 'WIRE-THHN-25',
    description: 'THHN electrical wire, 2.5 mm',
    quantity_ordered: 20,
    unit_cost: 1250,
    status: 'Pending Approval',
    target_date: '2027-01-20'
  }
];

async function seed({
  supplier = new Supplier(),
  purchaseOrder = new PurchaseOrder(),
  supplierFactory = new SupplierFactory(supplier),
  purchaseOrderFactory = new PurchaseOrderFactory(purchaseOrder)
} = {}) {
  const created = { suppliers: 0, purchaseOrders: 0 };
  const supplierByCode = new Map();

  for (const fixture of supplierFixtures) {
    let record = await supplier.findByCode(fixture.supplier_code);
    if (!record) {
      record = await supplierFactory.create(fixture);
      created.suppliers += 1;
    }
    supplierByCode.set(fixture.supplier_code, record);
  }

  for (const fixture of orderFixtures) {
    if (await purchaseOrder.findByNumber(fixture.po_number)) continue;
    const relatedSupplier = supplierByCode.get(fixture.supplier_code);
    if (!relatedSupplier) {
      throw new Error(`Missing supplier fixture for purchase order ${fixture.po_number}.`);
    }
    await purchaseOrderFactory.create({
      ...fixture,
      supplier_id: relatedSupplier.id,
      total_cost: fixture.quantity_ordered * fixture.unit_cost
    });
    created.purchaseOrders += 1;
  }

  return created;
}

module.exports = { seed, supplierFixtures, orderFixtures };
