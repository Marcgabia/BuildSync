const express = require('express');
const products = require('../controllers/productController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const canView = requirePermission('products.view', 'products.manage', 'inventory.view', 'inventory.manage');
const canManage = requirePermission('products.manage');

router.get('/', canView, products.list);
router.get('/export.csv', canView, requirePermission('reports.export'), products.exportCsv);
router.post('/', canManage, products.create);
router.get('/categories', canView, products.categories);
router.post('/categories', canManage, products.createCategory);
router.get('/categories/:id/edit', canManage, products.editCategory);
router.post('/categories/:id/edit', canManage, products.updateCategory);
router.post('/categories/:id/delete', canManage, products.deleteCategory);
router.get('/:id', canView, products.view);
router.get('/:id/edit', canManage, products.editForm);
router.post('/:id/edit', canManage, products.update);
router.post('/:id/delete', canManage, products.remove);
router.post('/:id/adjust', requirePermission('inventory.manage'), products.adjust);

module.exports = router;
