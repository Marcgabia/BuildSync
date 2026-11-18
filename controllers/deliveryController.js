const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const multer = require('multer');
const v = require('../lib/validate');
const { pool } = require('../lib/db');
const { handle, paramId, paginate, notFound, isUserError, sendCsv } = require('../lib/http');
const Delivery = require('../models/delivery');
const service = require('../services/deliveries');
const audit = require('../services/audit');
const { action } = require('./helpers');

const uploadDirectory = path.join(__dirname, '..', 'storage', 'deliveries');
const maxUploadBytes = 5 * 1024 * 1024;
const allowedTypes = {
  'application/pdf': { ext: '.pdf', magic: [Buffer.from('%PDF-')] },
  'image/png': { ext: '.png', magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])] },
  'image/jpeg': { ext: '.jpg', magic: [Buffer.from([0xff, 0xd8, 0xff])] }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => callback(null, Boolean(allowedTypes[file.mimetype]))
});

function readFilters(query) {
  return {
    search: String(query.q || '').trim().slice(0, 100),
    status: service.statuses.includes(query.status) ? query.status : 'All',
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : ''
  };
}

const list = handle(async (req, res) => {
  const filters = readFilters(req.query);
  const pageInfo = paginate(await Delivery.count(filters), req.query.page, 15);
  const deliveries = await Delivery.list({ ...filters, limit: pageInfo.pageSize, offset: pageInfo.offset });
  res.render('deliveries/index', {
    deliveries, filters, pageInfo, statuses: service.statuses, receivableOrders: await Delivery.receivableOrders()
  });
});

const exportCsv = handle(async (req, res) => {
  sendCsv(res, 'deliveries.csv', [
    { label: 'Delivery', key: 'delivery_number' }, { label: 'Supplier reference', key: 'reference_number' },
    { label: 'Purchase order', key: 'po_number' }, { label: 'Supplier', key: 'vendor_name' },
    { label: 'Expected', key: 'expected_date' }, { label: 'Delivered', key: 'delivery_date' },
    { label: 'Received by', key: 'received_by_name' }, { label: 'Accepted qty', key: 'accepted_total' },
    { label: 'Damaged qty', key: 'damaged_total' }, { label: 'Status', key: 'status' }
  ], await Delivery.list(readFilters(req.query)));
});

async function formLocals(orderId, extra = {}) {
  const orders = await Delivery.receivableOrders();
  const order = orderId ? orders.find((row) => Number(row.id) === Number(orderId)) : null;
  return {
    orders, order, lines: order ? await Delivery.orderLines(order.id) : [], error: null,
    values: { purchase_order_id: order ? order.id : '', expected_date: order ? order.target_date : '', status: 'Pending' },
    statuses: service.openStatuses, ...extra
  };
}

const newForm = handle(async (req, res) => {
  const orderId = v.isValidId(req.query.po) ? Number(req.query.po) : null;
  const locals = await formLocals(orderId);
  if (orderId && !locals.order) {
    await req.flash('error', 'That purchase order is not open for receiving. It must be approved, ordered, or partially received.');
    return res.redirect('/deliveries/new');
  }
  res.render('deliveries/form', locals);
});

const create = handle(async (req, res) => {
  try {
    const header = service.validateHeader(req.body);
    const receiveNow = req.body.intent === 'receive';
    const lines = receiveNow ? service.validateLines(req.body) : [];
    const id = await service.create(req, header, lines, { receiveNow });
    await req.flash('success', receiveNow ? 'Delivery received. Inventory and the purchase order were updated.' : 'Delivery recorded.');
    res.redirect(`/deliveries/${id}`);
  } catch (error) {
    if (!isUserError(error) || error.status === 404) throw error;
    const orderId = v.isValidId(req.body.purchase_order_id) ? Number(req.body.purchase_order_id) : null;
    res.status(400).render('deliveries/form', await formLocals(orderId, { error: error.message, values: req.body }));
  }
});

const view = handle(async (req, res) => {
  const delivery = await Delivery.findById(paramId(req));
  if (!delivery) throw notFound();
  const open = !delivery.confirmed_at && service.openStatuses.includes(delivery.status);
  res.render('deliveries/show', {
    delivery, open, lines: open ? await Delivery.orderLines(delivery.purchase_order_id) : [],
    statuses: [...service.openStatuses, 'Rejected']
  });
});

const receive = action(async (req) => {
  const lines = service.validateLines(req.body);
  const deliveryDate = v.date(req.body.delivery_date || v.today(), 'Delivery date');
  await service.receive(req, paramId(req), lines, deliveryDate);
}, { success: 'Delivery received. Inventory and the purchase order were updated.', redirect: (req) => `/deliveries/${req.params.id}` });

const updateStatus = action((req) => service.updateStatus(req, paramId(req), req.body.status, req.body.remarks), {
  success: 'Delivery status updated.', redirect: (req) => `/deliveries/${req.params.id}`
});

function hasMagic(buffer, type) {
  return allowedTypes[type].magic.some((magic) => buffer.subarray(0, magic.length).equals(magic));
}

const uploadAttachment = [
  (req, res, next) => upload.single('attachment')(req, res, async (error) => {
    if (!error) return next();
    await req.flash('error', error.code === 'LIMIT_FILE_SIZE' ? 'Attachments must be 5 MB or smaller.' : 'The upload could not be processed.');
    res.redirect(`/deliveries/${req.params.id}`);
  }),
  action(async (req) => {
    const id = paramId(req);
    const delivery = await Delivery.findById(id);
    if (!delivery) throw notFound();
    const file = req.file;
    if (!file) v.fail('Choose a PDF, PNG, or JPEG delivery receipt to upload.');
    if (!hasMagic(file.buffer, file.mimetype)) v.fail('The file content does not match a PDF, PNG, or JPEG document.');
    await fs.promises.mkdir(uploadDirectory, { recursive: true });
    const storedName = `${randomBytes(16).toString('hex')}${allowedTypes[file.mimetype].ext}`;
    await fs.promises.writeFile(path.join(uploadDirectory, storedName), file.buffer, { flag: 'wx' });
    const originalName = path.basename(String(file.originalname || 'receipt')).replace(/[^\w.\- ]/g, '_').slice(0, 255);
    await pool().execute(
      `INSERT INTO delivery_attachments (delivery_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, originalName, storedName, file.mimetype, file.size, req.user.id]
    );
    await audit.log(null, req, {
      action: 'upload', module: 'Deliveries', recordId: id,
      description: `Uploaded receipt "${originalName}" to delivery ${delivery.delivery_number}.`
    });
  }, { success: 'Receipt uploaded.', redirect: (req) => `/deliveries/${req.params.id}` })
];

/** Streams an attachment only to authorized users; files are never publicly served. */
const downloadAttachment = handle(async (req, res) => {
  const deliveryId = paramId(req);
  const attachmentId = paramId(req, 'attachmentId');
  const [rows] = await pool().execute(
    'SELECT * FROM delivery_attachments WHERE id = ? AND delivery_id = ?', [attachmentId, deliveryId]
  );
  const attachment = rows[0];
  if (!attachment || !/^[a-f0-9]{32}\.(pdf|png|jpg)$/.test(attachment.stored_name)) throw notFound();
  res.set('Content-Type', attachment.mime_type);
  res.set('Content-Disposition', `inline; filename="${attachment.original_name.replace(/"/g, '')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(uploadDirectory, attachment.stored_name), (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

module.exports = { list, exportCsv, newForm, create, view, receive, updateStatus, uploadAttachment, downloadAttachment };
