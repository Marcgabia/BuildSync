const PurchaseOrder = require('../models/purchaseOrder');
const Supplier = require('../models/supplier');
const Requisition = require('../models/requisition');
const { Product } = require('../models/product');
const { Department } = require('../models/user');
const { pool } = require('../lib/db');
const v = require('../lib/validate');
const { paramId, paginate, notFound, isUserError, sendCsv } = require('../lib/http');
const service = require('../services/purchaseOrders');
const approvals = require('../services/approvals');
const settings = require('../services/settings');
const audit = require('../services/audit');
const notifications = require('../services/notifications');
const { action } = require('./helpers');

const orderStatuses = service.statuses;

/** Validates the legacy single-item order form (kept for compatibility). */
function validatePurchaseOrder(body) {
  const values = {
    po_number: String(body.po_number || '').trim(),
    supplier_id: Number(body.supplier_id),
    item_sku: String(body.item_sku || '').trim(),
    description: String(body.description || '').trim(),
    quantity_ordered: Number(body.quantity_ordered),
    unit_cost: Number(body.unit_cost),
    target_date: String(body.target_date || '').trim()
  };

  if (!values.po_number || !values.item_sku || !values.description || !values.target_date) {
    return { error: 'Complete all purchase order fields before saving.' };
  }
  if (values.po_number.length > 50 || values.item_sku.length > 100 || values.description.length > 65535) {
    return { error: 'One or more purchase order fields exceed the allowed length.' };
  }
  if (!Number.isInteger(values.supplier_id) || values.supplier_id < 1) {
    return { error: 'Choose a valid supplier.' };
  }
  if (!Number.isInteger(values.quantity_ordered) || values.quantity_ordered < 1 || values.quantity_ordered > 2147483647) {
    return { error: 'Quantity must be a positive whole number.' };
  }
  if (!String(body.unit_cost === undefined ? '' : body.unit_cost).trim() ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(body.unit_cost).trim()) ||
      !Number.isFinite(values.unit_cost) ||
      values.unit_cost < 0 ||
      values.unit_cost > 99999999.99) {
    return { error: 'Unit cost must be a non-negative amount.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.target_date)) {
    return { error: 'Choose a valid target date.' };
  }
  const date = new Date(`${values.target_date}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== values.target_date) {
    return { error: 'Choose a valid target date.' };
  }

  const unitCostCents = Math.round(values.unit_cost * 100);
  if (unitCostCents * values.quantity_ordered > 999999999999) {
    return { error: 'The purchase order total is above the supported limit.' };
  }
  values.unit_cost = unitCostCents / 100;
  values.total_cost = (unitCostCents * values.quantity_ordered) / 100;
  return { values };
}

function isDuplicateError(error) {
  return error.code === 'ER_DUP_ENTRY';
}

function isForeignKeyError(error) {
  return error.code === 'ER_NO_REFERENCED_ROW_2';
}

function readFilters(query) {
  return {
    search: String(query.q || '').trim().slice(0, 100),
    status: orderStatuses.includes(query.status) ? query.status : 'All',
    supplierId: v.isValidId(query.supplier) ? Number(query.supplier) : 0,
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : ''
  };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createPurchaseOrderController(
  purchaseOrder = new PurchaseOrder(),
  supplier = new Supplier()
) {
  async function renderList(req, res, options = {}) {
    const filters = readFilters(req.query || {});
    const pageInfo = paginate(await purchaseOrder.count(filters), req.query && req.query.page, 15);
    const [orders, suppliers, allSuppliers] = await Promise.all([
      purchaseOrder.all({ ...filters, limit: pageInfo.pageSize, offset: pageInfo.offset }),
      purchaseOrder.activeSuppliers(),
      supplier.all()
    ]);
    const successMessages = {
      created: 'Purchase order created successfully.',
      updated: 'Purchase order status updated successfully.'
    };
    res.status(options.status || 200).render('purchase-orders', {
      orders,
      suppliers,
      allSuppliers,
      filters,
      pageInfo,
      statuses: orderStatuses,
      error: options.error || null,
      success: successMessages[options.success] || null,
      formValues: options.formValues || {}
    });
  }

  async function formLocals(extra = {}) {
    return {
      suppliers: await purchaseOrder.activeSuppliers(),
      products: await Product.active(),
      departments: await Department.active(),
      requisitions: await Requisition.approvedForConversion(),
      defaultTaxRate: await settings.get('default_tax_rate'),
      error: null,
      ...extra
    };
  }

  function itemsFromBody(body) {
    return v.list(body.product_id).map((productId, index) => ({
      product_id: productId,
      quantity: v.list(body.quantity)[index],
      unit_price: v.list(body.unit_price)[index],
      description: v.list(body.item_description)[index]
    }));
  }

  return {
    list: wrap(async (req, res) => {
      await renderList(req, res, { success: String(req.query.success || '') });
    }),

    exportCsv: wrap(async (req, res) => {
      const orders = await purchaseOrder.all(readFilters(req.query));
      sendCsv(res, 'purchase-orders.csv', [
        { label: 'PO number', key: 'po_number' }, { label: 'Supplier', key: 'vendor_name' },
        { label: 'Requisition', key: 'requisition_number' }, { label: 'Department', key: 'department_name' },
        { label: 'Order date', key: 'order_date' }, { label: 'Expected delivery', key: 'target_date' },
        { label: 'Subtotal', key: 'subtotal' }, { label: 'Discount', key: 'discount_amount' },
        { label: 'Tax', key: 'tax_amount' }, { label: 'Total', key: 'total_cost' }, { label: 'Status', key: 'status' }
      ], orders);
    }),

    /** Legacy single-item quick create; now records creator, audit, and approval notifications. */
    create: async (req, res, next) => {
      const body = req.body || {};
      const result = validatePurchaseOrder(body);
      if (result.error) {
        try {
          return await renderList(req, res, { error: result.error, status: 400, formValues: body });
        } catch (error) {
          return next(error);
        }
      }

      try {
        const activeSupplier = await supplier.findActiveById(result.values.supplier_id);
        if (!activeSupplier) {
          return await renderList(req, res, {
            error: 'Choose an active supplier before creating a purchase order.',
            status: 400,
            formValues: body
          });
        }
        const created = await purchaseOrder.create({
          ...result.values, created_by: req.user ? req.user.id : null,
          department_id: req.user ? req.user.departmentId : null
        });
        if (req.user) {
          await audit.log(null, req, {
            action: 'create', module: 'Purchase Orders', recordId: created.id,
            description: `Created purchase order ${created.po_number} (quick entry).`
          });
          await notifications.notifyPermission(null, 'purchase_orders.approve', {
            type: 'po_pending_approval', title: `Purchase order ${created.po_number} awaits approval`,
            message: `${req.user.fullName} submitted ${created.po_number} for approval.`,
            link: `/purchase-orders/${created.id}`, referenceType: 'purchase_order', referenceId: created.id
          }, { exceptUserId: req.user.id });
        }
        res.redirect('/purchase-orders?success=created');
      } catch (error) {
        const options = isDuplicateError(error)
          ? { error: 'That purchase order number is already in use.', status: 409, formValues: body }
          : isForeignKeyError(error)
            ? { error: 'The selected supplier no longer exists.', status: 400, formValues: body }
            : null;
        if (!options) return next(error);
        try {
          return await renderList(req, res, options);
        } catch (renderError) {
          return next(renderError);
        }
      }
    },

    newForm: wrap(async (req, res) => {
      let requisition = null;
      let items = [{}];
      const values = { order_date: v.today(), tax_rate: await settings.get('default_tax_rate'), discount_amount: '0.00' };
      if (v.isValidId(req.query.requisition)) {
        requisition = await Requisition.findById(Number(req.query.requisition));
        if (!requisition) throw notFound('The requisition no longer exists.');
        if (requisition.status !== 'Approved') {
          await req.flash('error', 'Only approved requisitions can be converted into purchase orders.');
          return res.redirect(`/requisitions/${requisition.id}`);
        }
        items = requisition.items.map((item) => ({
          product_id: item.product_id, quantity: item.quantity, unit_price: item.estimated_unit_price,
          description: item.description
        }));
        const supplierIds = [...new Set(requisition.items.map((item) => item.supplier_id).filter(Boolean))];
        values.supplier_id = supplierIds.length === 1 ? supplierIds[0] : '';
        values.target_date = requisition.required_date;
        values.department_id = requisition.department_id;
        values.notes = `Requisition ${requisition.requisition_number}: ${requisition.purpose}`.slice(0, 5000);
      }
      res.render('purchase-orders/form', await formLocals({ order: null, requisition, values, items }));
    }),

    store: wrap(async (req, res) => {
      const requisitionId = v.isValidId(req.body.requisition_id) ? Number(req.body.requisition_id) : null;
      try {
        const values = service.validateForm(req.body);
        const id = await service.create(req, values, { requisitionId, submit: req.body.intent === 'submit' });
        await req.flash('success', req.body.intent === 'submit' ? 'Purchase order submitted for approval.' : 'Purchase order saved as draft.');
        res.redirect(`/purchase-orders/${id}`);
      } catch (error) {
        if (!isUserError(error) || error.status === 404) throw error;
        const requisition = requisitionId ? await Requisition.findById(requisitionId) : null;
        res.status(400).render('purchase-orders/form', await formLocals({
          order: null, requisition, values: req.body, items: itemsFromBody(req.body), error: error.message
        }));
      }
    }),

    view: wrap(async (req, res) => {
      const order = await purchaseOrder.findDetail(paramId(req));
      if (!order) throw notFound();
      const connection = pool();
      res.render('purchase-orders/show', {
        order,
        history: await approvals.history(connection, 'purchase_order', order.id),
        decision: await approvals.eligibility(connection, req, 'purchase_order', order),
        cancellable: service.cancellableStatuses.includes(order.status) &&
          !order.items.some((item) => Number(item.received_quantity) > 0),
        receivable: service.receivableStatuses.includes(order.status)
      });
    }),

    print: wrap(async (req, res) => {
      const order = await purchaseOrder.findDetail(paramId(req));
      if (!order) throw notFound();
      res.render('purchase-orders/print', { order, organization: await settings.get('organization_name') });
    }),

    editForm: wrap(async (req, res) => {
      const order = await purchaseOrder.findDetail(paramId(req));
      if (!order) throw notFound();
      if (order.status !== 'Draft') {
        await req.flash('error', 'Only draft purchase orders can be edited. Approved and completed orders are locked.');
        return res.redirect(`/purchase-orders/${order.id}`);
      }
      const items = order.items.map((item) => ({
        product_id: item.product_id, quantity: item.quantity, unit_price: item.unit_price, description: item.description
      }));
      res.render('purchase-orders/form', await formLocals({ order, requisition: null, values: order, items }));
    }),

    update: wrap(async (req, res) => {
      const id = paramId(req);
      try {
        const values = service.validateForm(req.body);
        await service.update(req, id, values, { submit: req.body.intent === 'submit' });
        await req.flash('success', req.body.intent === 'submit' ? 'Purchase order updated and submitted for approval.' : 'Purchase order updated.');
        res.redirect(`/purchase-orders/${id}`);
      } catch (error) {
        if (!isUserError(error) || error.status === 404) throw error;
        const order = await purchaseOrder.findDetail(id);
        res.status(400).render('purchase-orders/form', await formLocals({
          order, requisition: null, values: { ...order, ...req.body }, items: itemsFromBody(req.body), error: error.message
        }));
      }
    }),

    submit: action((req) => service.submit(req, paramId(req)), {
      success: 'Purchase order submitted for approval.', redirect: (req) => `/purchase-orders/${req.params.id}`
    }),

    markOrdered: action((req) => service.markOrdered(req, paramId(req)), {
      success: 'Purchase order marked as ordered.', redirect: (req) => `/purchase-orders/${req.params.id}`
    }),

    cancel: action((req) => service.cancel(req, paramId(req), req.body.reason), {
      success: 'Purchase order cancelled. Any budget commitment was released.',
      redirect: (req) => `/purchase-orders/${req.params.id}`
    }),

    /**
     * Legacy status endpoint used by the order register. Each requested status is
     * routed through the governed workflow so permissions and rules still apply.
     */
    updateStatus: action(async (req) => {
      const id = paramId(req);
      const status = String((req.body || {}).status || '');
      if (!orderStatuses.includes(status)) v.fail('Choose a valid purchase order status.');
      const order = await purchaseOrder.findById(id);
      if (!order) throw notFound();
      if (order.status === status) return { redirect: '/purchase-orders' };
      const deny = (permission) => {
        if (!req.can(permission)) {
          const error = new v.ValidationError('You do not have permission to make this status change.');
          error.status = 403;
          throw error;
        }
      };
      if (status === 'Pending Approval' && order.status === 'Draft') {
        deny('purchase_orders.manage');
        await service.submit(req, id);
      } else if (status === 'Approved' && order.status === 'Pending Approval') {
        await approvals.decide(req, 'purchase_order', id, 'approve', req.body.comments);
      } else if (status === 'Ordered' && order.status === 'Approved') {
        deny('purchase_orders.manage');
        await service.markOrdered(req, id);
      } else if (status === 'Cancelled') {
        deny('purchase_orders.manage');
        await service.cancel(req, id, req.body.reason || 'Cancelled from the order register.');
      } else if (['Partially Received', 'Completed'].includes(status)) {
        v.fail('Record a delivery to mark goods as received; the order status updates automatically.');
      } else {
        v.fail(`An order cannot move from "${order.status}" to "${status}".`);
      }
      return { redirect: '/purchase-orders?success=updated' };
    }, { success: null, redirect: '/purchase-orders' })
  };
}

module.exports = {
  createPurchaseOrderController,
  validatePurchaseOrder,
  orderStatuses
};
