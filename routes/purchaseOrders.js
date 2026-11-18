const express = require('express');
const { createPurchaseOrderController } = require('../controllers/purchaseOrderController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const controller = createPurchaseOrderController();
const canView = requirePermission('purchase_orders.view', 'purchase_orders.manage', 'purchase_orders.approve');
const canManage = requirePermission('purchase_orders.manage');
const canManageOrApprove = requirePermission('purchase_orders.manage', 'purchase_orders.approve');

router.get('/', canView, controller.list);
router.get('/export.csv', canView, requirePermission('reports.export'), controller.exportCsv);
router.get('/new', canManage, controller.newForm);
router.post('/', canManage, controller.store);
router.post('/add', canManage, controller.create);
router.get('/:id', canView, controller.view);
router.get('/:id/print', canView, controller.print);
router.get('/:id/edit', canManage, controller.editForm);
router.post('/:id/edit', canManage, controller.update);
router.post('/:id/submit', canManage, controller.submit);
router.post('/:id/mark-ordered', canManage, controller.markOrdered);
router.post('/:id/cancel', canManageOrApprove, controller.cancel);
router.post('/:id/status', canManageOrApprove, controller.updateStatus);

module.exports = router;
