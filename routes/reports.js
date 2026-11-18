const express = require('express');
const reports = require('../controllers/reportController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

router.get('/', requirePermission('reports.view'), reports.index);
router.get('/:key', requirePermission('reports.view'), reports.show);

module.exports = router;
