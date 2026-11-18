const v = require('../lib/validate');
const { pool } = require('../lib/db');
const { handle, paramId, paginate, notFound, forbidden, isUserError } = require('../lib/http');
const Requisition = require('../models/requisition');
const { Product } = require('../models/product');
const { Department } = require('../models/user');
const service = require('../services/requisitions');
const approvals = require('../services/approvals');
const { action } = require('./helpers');

function canSeeAll(req) {
  return req.can('requisitions.view_all', 'requisitions.approve');
}

function readFilters(req) {
  const q = req.query;
  return {
    search: String(q.q || '').trim().slice(0, 100),
    status: service.statuses.includes(q.status) ? q.status : 'All',
    departmentId: v.isValidId(q.department) ? Number(q.department) : 0,
    from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '',
    scope: canSeeAll(req) && q.scope !== 'mine' ? 'all' : 'mine'
  };
}

const list = handle(async (req, res) => {
  const filters = readFilters(req);
  const query = { ...filters, ownerId: filters.scope === 'mine' ? req.user.id : 0 };
  const pageInfo = paginate(await Requisition.count(query), req.query.page, 15);
  const requisitions = await Requisition.list({ ...query, limit: pageInfo.pageSize, offset: pageInfo.offset });
  res.render('requisitions/index', {
    requisitions, filters, pageInfo, statuses: service.statuses, departments: await Department.active(),
    canSeeAll: canSeeAll(req)
  });
});

async function formLocals(req, extra = {}) {
  return {
    products: await Product.active(),
    departments: await Department.active(),
    canChooseDepartment: !req.user.departmentId || canSeeAll(req),
    error: null,
    ...extra
  };
}

function itemsFromBody(body) {
  const ids = v.list(body.product_id);
  return ids.map((productId, index) => ({
    product_id: productId,
    quantity: v.list(body.quantity)[index],
    estimated_unit_price: v.list(body.unit_price)[index],
    description: v.list(body.item_description)[index]
  }));
}

const newForm = handle(async (req, res) => {
  res.render('requisitions/form', await formLocals(req, {
    requisition: null,
    values: { department_id: req.user.departmentId, required_date: '', purpose: '' },
    items: [{}]
  }));
});

const create = handle(async (req, res) => {
  try {
    const values = service.validateForm(req.body, req.user, { canChooseDepartment: !req.user.departmentId || canSeeAll(req) });
    const id = await service.create(req, values, { submit: req.body.intent === 'submit' });
    await req.flash('success', req.body.intent === 'submit' ? 'Requisition submitted for approval.' : 'Requisition saved as draft.');
    res.redirect(`/requisitions/${id}`);
  } catch (error) {
    if (!isUserError(error)) throw error;
    res.status(400).render('requisitions/form', await formLocals(req, {
      requisition: null, values: req.body, items: itemsFromBody(req.body), error: error.message
    }));
  }
});

async function loadVisible(req) {
  const requisition = await Requisition.findById(paramId(req));
  if (!requisition) throw notFound();
  if (Number(requisition.requested_by) !== req.user.id && !canSeeAll(req)) throw forbidden();
  return requisition;
}

const view = handle(async (req, res) => {
  const requisition = await loadVisible(req);
  const connection = pool();
  res.render('requisitions/show', {
    requisition,
    history: await approvals.history(connection, 'requisition', requisition.id),
    decision: await approvals.eligibility(connection, req, 'requisition', requisition),
    isOwner: Number(requisition.requested_by) === req.user.id,
    editable: service.editableStatuses.includes(requisition.status),
    cancellable: service.cancellableStatuses.includes(requisition.status),
    activeOrder: requisition.orders.find((order) => order.status !== 'Cancelled') || null
  });
});

const editForm = handle(async (req, res) => {
  const requisition = await loadVisible(req);
  if (Number(requisition.requested_by) !== req.user.id) throw forbidden('Only the requester can edit this requisition.');
  if (!service.editableStatuses.includes(requisition.status)) {
    await req.flash('error', 'Only draft or returned requisitions can be edited.');
    return res.redirect(`/requisitions/${requisition.id}`);
  }
  res.render('requisitions/form', await formLocals(req, {
    requisition,
    values: requisition,
    items: requisition.items.map((item) => ({ ...item, product_id: item.product_id }))
  }));
});

const update = handle(async (req, res) => {
  const id = paramId(req);
  try {
    const values = service.validateForm(req.body, req.user, { canChooseDepartment: !req.user.departmentId || canSeeAll(req) });
    await service.update(req, id, values, { submit: req.body.intent === 'submit' });
    await req.flash('success', req.body.intent === 'submit' ? 'Requisition updated and submitted for approval.' : 'Requisition updated.');
    res.redirect(`/requisitions/${id}`);
  } catch (error) {
    if (!isUserError(error) || error.status === 404) throw error;
    const requisition = await Requisition.findById(id);
    res.status(400).render('requisitions/form', await formLocals(req, {
      requisition, values: req.body, items: itemsFromBody(req.body), error: error.message
    }));
  }
});

const submit = action((req) => service.submit(req, paramId(req)), {
  success: 'Requisition submitted for approval.', redirect: (req) => `/requisitions/${req.params.id}`
});

const cancel = action((req) => service.cancel(req, paramId(req)), {
  success: 'Requisition cancelled.', redirect: (req) => `/requisitions/${req.params.id}`
});

module.exports = { list, newForm, create, view, editForm, update, submit, cancel };
