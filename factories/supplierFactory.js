const { randomBytes } = require('node:crypto');
const Supplier = require('../models/supplier');

class SupplierFactory {
  constructor(model = new Supplier()) {
    this.model = model;
  }

  build(overrides = {}) {
    const token = randomBytes(4).toString('hex').toUpperCase();
    return {
      supplier_code: `SUP-${token}`,
      vendor_name: `Sample Building Supply ${token}`,
      key_account_manager: 'Alex Santos',
      contact_number: '+63 917 000 0000',
      email: `supplier-${token.toLowerCase()}@example.test`,
      warehouse_address: 'Calapan City, Oriental Mindoro',
      material_category: 'Building materials',
      credit_terms: 30,
      delivery_lead_time: 7,
      status: 'Active',
      ...overrides
    };
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

module.exports = SupplierFactory;
