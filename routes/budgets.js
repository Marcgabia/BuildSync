const express = require('express');
const budgets = require('../controllers/budgetController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const canView = requirePermission('budgets.view', 'budgets.manage');
const canManage = requirePermission('budgets.manage');

router.get('/', canView, budgets.index);
router.get('/export.csv', canView, requirePermission('reports.export'), budgets.exportCsv);
router.post('/', canManage, budgets.create);
router.get('/:id', canView, budgets.view);
router.get('/:id/edit', canManage, budgets.editForm);
router.post('/:id/edit', canManage, budgets.update);
router.post('/:id/delete', canManage, budgets.remove);

module.exports = router;
