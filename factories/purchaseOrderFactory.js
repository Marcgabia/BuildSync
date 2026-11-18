const { randomBytes } = require('node:crypto');
const PurchaseOrder = require('../models/purchaseOrder');

class PurchaseOrderFactory {
  constructor(model = new PurchaseOrder()) {
    this.model = model;
  }

  build(overrides = {}) {
    const token = randomBytes(4).toString('hex').toUpperCase();
    const quantity = 10;
    const unitCost = 125.5;
    const targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() + 14);

    const attributes = {
      po_number: `PO-${token}`,
      supplier_id: null,
      item_sku: `SAMPLE-${token}`,
      description: 'Sample order of construction materials',
      quantity_ordered: quantity,
      unit_cost: unitCost,
      total_cost: quantity * unitCost,
      status: 'Pending Approval',
      target_date: targetDate.toISOString().slice(0, 10),
      ...overrides
    };
    if (overrides.total_cost === undefined) {
      attributes.total_cost =
        (Math.round(Number(attributes.unit_cost) * 100) * Number(attributes.quantity_ordered)) / 100;
    }
    return attributes;
  }

  buildMany(count, overrides = {}) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('Factory count must be a non-negative integer.');
    }
    return Array.from({ length: count }, () => this.build(overrides));
  }

  create(overrides = {}) {
    return this.model.create(this.build(overrides));
  }
}

module.exports = PurchaseOrderFactory;
