const express = require('express');
const approvals = require('../controllers/approvalController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

router.get('/', requirePermission('requisitions.approve', 'purchase_orders.approve'), approvals.index);
router.post('/requisitions/:id', requirePermission('requisitions.approve'), approvals.decideRequisition);
router.post('/purchase-orders/:id', requirePermission('purchase_orders.approve'), approvals.decidePurchaseOrder);

module.exports = router;
