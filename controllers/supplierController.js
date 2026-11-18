const Supplier = require('../models/supplier');
const audit = require('../services/audit');

const supplierStatuses = ['Active', 'Pending Qualification', 'Inactive'];
const supplierFields = [
  'supplier_code',
  'vendor_name',
  'key_account_manager',
  'contact_number',
  'email',
  'warehouse_address',
  'material_category'
];
const supplierFieldLimits = {
  supplier_code: 50,
  vendor_name: 255,
  key_account_manager: 255,
  contact_number: 50,
  email: 255,
  material_category: 255,
  warehouse_address: 10000
};
const supplierPageSize = 10;

function parsePage(value) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function isValidId(value) {
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function validateSupplier(body) {
  const values = Object.fromEntries(
    supplierFields.map((field) => [field, String(body[field] || '').trim()])
  );
  if (!String(body.credit_terms === undefined ? '' : body.credit_terms).trim() ||
      !String(body.delivery_lead_time === undefined ? '' : body.delivery_lead_time).trim()) {
    return { error: 'Enter credit terms and delivery lead time.' };
  }
  values.credit_terms = Number(body.credit_terms);
  values.delivery_lead_time = Number(body.delivery_lead_time);

  if (supplierFields.some((field) => !values[field])) {
    return { error: 'Complete all supplier fields before saving.' };
  }
  if (Object.entries(supplierFieldLimits).some(([field, limit]) => values[field].length > limit)) {
    return { error: 'One or more supplier fields exceed the allowed length.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return { error: 'Enter a valid email address.' };
  }
  if (!Number.isInteger(values.credit_terms) || values.credit_terms < 0 || values.credit_terms > 2147483647) {
    return { error: 'Credit terms must be a non-negative whole number.' };
  }
  if (!Number.isInteger(values.delivery_lead_time) || values.delivery_lead_time < 0 || values.delivery_lead_time > 2147483647) {
    return { error: 'Delivery lead time must be a non-negative whole number.' };
  }

  values.tax_id = String(body.tax_id || '').trim() || null;
  if (values.tax_id && values.tax_id.length > 50) {
    return { error: 'Tax identification number must be at most 50 characters.' };
  }
  const rating = String(body.reliability_rating === undefined ? '' : body.reliability_rating).trim();
  values.reliability_rating = null;
  if (rating) {
    if (!/^[1-5]$/.test(rating)) return { error: 'Service reliability rating must be between 1 and 5.' };
    values.reliability_rating = Number(rating);
  }

  return { values };
}

function isDuplicateError(error) {
  return error.code === 'ER_DUP_ENTRY' ||
    (String(error.code || '').startsWith('SQLITE_CONSTRAINT') &&
      /UNIQUE constraint failed/.test(error.message));
}

function createSupplierController(supplier = new Supplier()) {
  async function renderList(res, options = {}) {
    const search = options.search || '';
    const status = options.status || 'All';
    const total = await supplier.count({ search, status });
    const totalPages = Math.max(1, Math.ceil(total / supplierPageSize));
    const page = Math.min(options.page || 1, totalPages);
    const suppliers = await supplier.all({
      search,
      status,
      limit: supplierPageSize,
      offset: (page - 1) * supplierPageSize
    });
    const successMessages = {
      created: 'Supplier created successfully.',
      updated: 'Supplier updated successfully.',
      deactivated: 'Supplier deactivated. Existing purchase history has been preserved.',
      activated: 'Supplier reactivated.',
      deleted: 'Supplier deleted.'
    };
    res.status(options.httpStatus || 200).render('suppliers', {
      suppliers,
      search,
      status,
      page,
      totalPages,
      total,
      statuses: supplierStatuses,
      error: options.error || null,
      success: successMessages[options.success] || null,
      formValues: options.formValues || {}
    });
  }

  return {
    list: async (req, res, next) => {
      try {
        const search = String(req.query.q || '').trim().slice(0, 100);
        const status = String(req.query.status || 'All');
        if (status !== 'All' && !supplierStatuses.includes(status)) {
          return await renderList(res, {
            search,
            error: 'Choose a valid supplier status filter.',
            httpStatus: 400
          });
        }
        await renderList(res, {
          search,
          status,
          page: parsePage(req.query.page),
          success: String(req.query.success || '')
        });
      } catch (error) {
        next(error);
      }
    },

    view: async (req, res, next) => {
      try {
        if (!isValidId(req.params.id)) return res.sendStatus(404);
        const record = await supplier.findWithPurchaseHistory(req.params.id);
        if (!record) return res.sendStatus(404);
        res.render('supplier-detail', { supplier: record });
      } catch (error) {
        next(error);
      }
    },

    deactivate: async (req, res, next) => {
      if (!isValidId(req.params.id)) return res.sendStatus(404);
      try {
        const record = await supplier.updateStatus(req.params.id, 'Inactive');
        if (!record) return res.sendStatus(404);
        await audit.log(null, req, {
          action: 'deactivate', module: 'Suppliers', recordId: record.id,
          description: `Deactivated supplier ${record.vendor_name} (${record.supplier_code}).`
        });
        res.redirect('/suppliers?status=All&success=deactivated');
      } catch (error) {
        next(error);
      }
    },

    activate: async (req, res, next) => {
      if (!isValidId(req.params.id)) return res.sendStatus(404);
      try {
        const record = await supplier.updateStatus(req.params.id, 'Active');
        if (!record) return res.sendStatus(404);
        await audit.log(null, req, {
          action: 'activate', module: 'Suppliers', recordId: record.id,
          description: `Reactivated supplier ${record.vendor_name} (${record.supplier_code}).`
        });
        res.redirect('/suppliers?status=All&success=activated');
      } catch (error) {
        next(error);
      }
    },

    remove: async (req, res, next) => {
      if (!isValidId(req.params.id)) return res.sendStatus(404);
      try {
        const record = await supplier.findById(req.params.id);
        if (!record) return res.sendStatus(404);
        if (await supplier.dependencyCount(record.id) > 0) {
          return await renderList(res, {
            error: 'This supplier has purchase orders, deliveries, or products on record and cannot be deleted. Deactivate it instead to preserve history.',
            httpStatus: 409
          });
        }
        await supplier.remove(record.id);
        await audit.log(null, req, {
          action: 'delete', module: 'Suppliers', recordId: record.id,
          description: `Deleted unused supplier ${record.vendor_name} (${record.supplier_code}).`
        });
        res.redirect('/suppliers?success=deleted');
      } catch (error) {
        next(error);
      }
    },

    create: async (req, res, next) => {
      const body = req.body || {};
      const result = validateSupplier(body);
      if (result.error) {
        try {
          return await renderList(res, { error: result.error, httpStatus: 400, formValues: body });
        } catch (error) {
          return next(error);
        }
      }

      try {
        const created = await supplier.create(result.values);
        await audit.log(null, req, {
          action: 'create', module: 'Suppliers', recordId: created.id,
          description: `Added supplier ${created.vendor_name} (${created.supplier_code}).`
        });
        res.redirect('/suppliers?success=created');
      } catch (error) {
        if (isDuplicateError(error)) {
          try {
            return await renderList(res, {
              error: 'That supplier code is already in use.',
              httpStatus: 409,
              formValues: body
            });
          } catch (renderError) {
            return next(renderError);
          }
        }
        next(error);
      }
    },

    editForm: async (req, res, next) => {
      try {
        if (!isValidId(req.params.id)) return res.sendStatus(404);
        const record = await supplier.findById(req.params.id);
        if (!record) return res.sendStatus(404);
        res.render('supplier-edit', { supplier: record, statuses: supplierStatuses, error: null });
      } catch (error) {
        next(error);
      }
    },

    update: async (req, res, next) => {
      const body = req.body || {};
      const result = validateSupplier(body);
      const status = String(body.status || '');
      if (result.error || !supplierStatuses.includes(status)) {
        try {
          const record = await supplier.findById(req.params.id);
          if (!record) return res.sendStatus(404);
          return res.status(400).render('supplier-edit', {
            supplier: { ...record, ...body },
            statuses: supplierStatuses,
            error: result.error || 'Choose a valid supplier status.'
          });
        } catch (error) {
          return next(error);
        }
      }

      try {
        if (!isValidId(req.params.id)) return res.sendStatus(404);
        const record = await supplier.update(req.params.id, { ...result.values, status });
        if (!record) return res.sendStatus(404);
        await audit.log(null, req, {
          action: 'update', module: 'Suppliers', recordId: record.id,
          description: `Updated supplier ${record.vendor_name} (${record.supplier_code}); status ${record.status}.`
        });
        res.redirect('/suppliers?success=updated');
      } catch (error) {
        if (isDuplicateError(error)) {
          try {
            const record = await supplier.findById(req.params.id);
            if (!record) return res.sendStatus(404);
            return res.status(409).render('supplier-edit', {
              supplier: { ...record, ...body },
              statuses: supplierStatuses,
              error: 'That supplier code is already in use.'
            });
          } catch (renderError) {
            return next(renderError);
          }
        }
        next(error);
      }
    }
  };
}

module.exports = { createSupplierController, validateSupplier, supplierStatuses };
