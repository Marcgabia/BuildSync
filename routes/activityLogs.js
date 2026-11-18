const express = require('express');
const logs = require('../controllers/activityLogController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();

router.get('/', requirePermission('activity_logs.view'), logs.index);
router.get('/export.csv', requirePermission('activity_logs.view'), requirePermission('reports.export'), logs.exportCsv);

module.exports = router;
