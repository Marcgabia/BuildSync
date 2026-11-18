const express = require('express');
const deliveries = require('../controllers/deliveryController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const canView = requirePermission('deliveries.view', 'deliveries.manage');
const canManage = requirePermission('deliveries.manage');

router.get('/', canView, deliveries.list);
router.get('/export.csv', canView, requirePermission('reports.export'), deliveries.exportCsv);
router.get('/new', canManage, deliveries.newForm);
router.post('/', canManage, deliveries.create);
router.get('/:id', canView, deliveries.view);
router.post('/:id/receive', canManage, deliveries.receive);
router.post('/:id/status', canManage, deliveries.updateStatus);
router.post('/:id/attachments', canManage, deliveries.uploadAttachment);
router.get('/:id/attachments/:attachmentId', canView, deliveries.downloadAttachment);

module.exports = router;
