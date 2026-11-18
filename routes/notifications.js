const express = require('express');
const notifications = require('../controllers/notificationController');

// Notifications are personal: every signed-in user sees only their own records.
const router = express.Router();

router.get('/', notifications.index);
router.post('/read-all', notifications.markAllRead);
router.get('/:id/open', notifications.open);
router.post('/:id/read', notifications.markRead);

module.exports = router;
