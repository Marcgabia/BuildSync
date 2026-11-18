const express = require('express');
const admin = require('../controllers/adminController');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const users = requirePermission('users.manage');
const roles = requirePermission('roles.manage');
const settings = requirePermission('settings.manage');

router.get('/admin/users', users, admin.users);
router.get('/admin/users/new', users, admin.newUser);
router.post('/admin/users', users, admin.createUser);
router.get('/admin/users/:id/edit', users, admin.editUser);
router.post('/admin/users/:id/edit', users, admin.updateUser);
router.post('/admin/users/:id/toggle', users, admin.toggleUser);
router.post('/admin/users/:id/reset-password', users, admin.resetPassword);

router.get('/admin/roles', roles, admin.roles);
router.get('/admin/roles/new', roles, admin.newRole);
router.post('/admin/roles', roles, admin.createRole);
router.get('/admin/roles/:id/edit', roles, admin.editRole);
router.post('/admin/roles/:id/edit', roles, admin.updateRole);
router.post('/admin/roles/:id/toggle', roles, admin.toggleRole);

router.get('/settings', settings, admin.settingsPage);
router.post('/settings', settings, admin.updateSettings);
router.post('/settings/departments', settings, admin.createDepartment);
router.post('/settings/departments/:id', settings, admin.updateDepartment);

module.exports = router;
