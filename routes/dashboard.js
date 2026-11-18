const express = require('express');
const { createDashboardController } = require('../controllers/dashboardController');

const router = express.Router();
const controller = createDashboardController();

router.get('/', controller);

module.exports = router;
