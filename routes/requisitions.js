const express = require('express');
const requisitions = require('../controllers/requisitionController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const canView = requirePermission('requisitions.create', 'requisitions.view_all', 'requisitions.approve');
const canCreate = requirePermission('requisitions.create');

router.get('/', canView, requisitions.list);
router.get('/new', canCreate, requisitions.newForm);
router.post('/', canCreate, requisitions.create);
router.get('/:id', canView, requisitions.view);
router.get('/:id/edit', canCreate, requisitions.editForm);
router.post('/:id/edit', canCreate, requisitions.update);
router.post('/:id/submit', canCreate, requisitions.submit);
router.post('/:id/cancel', canView, requisitions.cancel);

module.exports = router;
