const express = require('express');
const products = require('../controllers/productController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

router.get('/', requirePermission('inventory.view', 'inventory.manage'), products.inventoryOverview);

module.exports = router;
