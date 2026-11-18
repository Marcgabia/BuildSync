const express = require('express');
const { createSupplierController } = require('../controllers/supplierController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const controller = createSupplierController();
const canView = requirePermission('suppliers.view', 'suppliers.manage');
const canManage = requirePermission('suppliers.manage');

router.get('/', canView, controller.list);
router.post('/add', canManage, controller.create);
router.get('/:id', canView, controller.view);
router.post('/:id/deactivate', canManage, controller.deactivate);
router.post('/:id/activate', canManage, controller.activate);
router.post('/:id/delete', canManage, controller.remove);
router.get('/:id/edit', canManage, controller.editForm);
router.post('/:id/edit', canManage, controller.update);

module.exports = router;
