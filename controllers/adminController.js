const { pool, withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { handle, paramId, paginate, notFound, forbidden, isDuplicateError, isUserError } = require('../lib/http');
const { hashPassword, validatePasswordStrength } = require('../lib/passwords');
const { destroyUserSessions } = require('../middleware/session');
const { User, Role, Department } = require('../models/user');
const audit = require('../services/audit');
const notifications = require('../services/notifications');
const settings = require('../services/settings');
const { action } = require('./helpers');

const userStatuses = ['Active', 'Pending', 'Inactive', 'Locked'];

/* ---------------- Users ---------------- */

const users = handle(async (req, res) => {
  const filters = {
    search: String(req.query.q || '').trim().slice(0, 100),
    status: userStatuses.includes(req.query.status) ? req.query.status : 'All',
    roleId: v.isValidId(req.query.role) ? Number(req.query.role) : 0
  };
  const pageInfo = paginate(await User.count(filters), req.query.page, 20);
  res.render('admin/users', {
    users: await User.list({ ...filters, limit: pageInfo.pageSize, offset: pageInfo.offset }),
    filters, pageInfo, roles: await Role.list(), statuses: userStatuses
  });
});

async function userFormLocals(extra) {
  return { roles: await Role.list(), departments: await Department.active(), statuses: userStatuses, error: null, ...extra };
}

function validateUser(body, { isNew }) {
  const values = {
    full_name: v.text(body.full_name, 'Full name', { max: 150 }),
    email: v.email(body.email),
    department_id: String(body.department_id || '').trim() ? v.id(body.department_id, 'Department') : null,
    status: v.oneOf(body.status || 'Active', 'Status', userStatuses),
    role_ids: [...new Set(v.list(body.role_ids).map((id) => v.id(id, 'Role')))]
  };
  if (!values.role_ids.length) v.fail('Assign at least one role.');
  if (isNew) {
    const strength = validatePasswordStrength(body.password);
    if (strength) v.fail(strength);
    values.password = body.password;
  }
  return values;
}

async function assignRoles(connection, userId, roleIds, assignedBy) {
  const [valid] = await connection.query('SELECT id FROM roles WHERE id IN (?)', [roleIds]);
  if (valid.length !== roleIds.length) v.fail('One of the selected roles no longer exists.');
  await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [userId]);
  for (const roleId of roleIds) {
    await connection.execute('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)', [userId, roleId, assignedBy]);
  }
}

async function roleNames(connection, roleIds) {
  const [rows] = await connection.query('SELECT name FROM roles WHERE id IN (?) ORDER BY name', [roleIds]);
  return rows.map((row) => row.name).join(', ');
}

const newUser = handle(async (req, res) => {
  res.render('admin/user-form', await userFormLocals({ user: null, values: { status: 'Active', role_ids: [] } }));
});

const createUser = handle(async (req, res) => {
  try {
    const values = validateUser(req.body, { isNew: true });
    const passwordHash = await hashPassword(values.password);
    const id = await withTransaction(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO users (full_name, email, password_hash, department_id, status, must_change_password)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [values.full_name, values.email, passwordHash, values.department_id, values.status]
      );
      await assignRoles(connection, result.insertId, values.role_ids, req.user.id);
      await audit.log(connection, req, {
        action: 'create', module: 'Users', recordId: result.insertId,
        description: `Created user ${values.full_name} <${values.email}> with roles: ${await roleNames(connection, values.role_ids)}.`
      });
      await notifications.notifyUser(connection, result.insertId, {
        type: 'account', title: 'Welcome to BuildSync',
        message: `Your account was created by ${req.user.fullName}. You will be asked to change your temporary password.`,
        link: '/account/password'
      });
      return result.insertId;
    });
    await req.flash('success', 'User created. Share the temporary password securely; it must be changed at first sign-in.');
    res.redirect(`/admin/users/${id}/edit`);
  } catch (error) {
    const message = isDuplicateError(error) ? 'A user with that email address already exists.' : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('admin/user-form', await userFormLocals({
      user: null, values: { ...req.body, role_ids: v.list(req.body.role_ids).map(Number) }, error: message
    }));
  }
});

const editUser = handle(async (req, res) => {
  const user = await User.findById(paramId(req));
  if (!user) throw notFound();
  res.render('admin/user-form', await userFormLocals({ user, values: { ...user, role_ids: user.roleIds } }));
});

const updateUser = handle(async (req, res) => {
  const id = paramId(req);
  const user = await User.findById(id);
  if (!user) throw notFound();
  try {
    const values = validateUser(req.body, { isNew: false });
    if (id === req.user.id && values.status !== 'Active') v.fail('You cannot deactivate your own account.');
    await withTransaction(async (connection) => {
      const [[superRole]] = await connection.execute("SELECT id FROM roles WHERE role_key = 'super_admin'");
      if (id === req.user.id && user.roleIds.includes(Number(superRole.id)) && !values.role_ids.includes(Number(superRole.id))) {
        v.fail('You cannot remove the Super Admin role from your own account.');
      }
      await connection.execute(
        'UPDATE users SET full_name = ?, email = ?, department_id = ?, status = ?, locked_until = IF(? = \'Active\', NULL, locked_until) WHERE id = ?',
        [values.full_name, values.email, values.department_id, values.status, values.status, id]
      );
      const rolesChanged = [...values.role_ids].sort().join() !== [...user.roleIds].sort().join();
      if (rolesChanged) await assignRoles(connection, id, values.role_ids, req.user.id);
      await audit.log(connection, req, {
        action: 'update', module: 'Users', recordId: id,
        description: `Updated user ${values.full_name}: status ${values.status}` +
          `${rolesChanged ? `, roles now ${await roleNames(connection, values.role_ids)}` : ''}.`
      });
      if (rolesChanged || values.status !== user.status) {
        await notifications.notifyUser(connection, id, {
          type: 'account', title: 'Your account was updated',
          message: `${req.user.fullName} changed your ${rolesChanged ? 'roles' : 'account status'}.`, link: '/'
        });
      }
    });
    if (values.status !== 'Active') await destroyUserSessions(id);
    await req.flash('success', 'User updated.');
    res.redirect('/admin/users');
  } catch (error) {
    const message = isDuplicateError(error) ? 'A user with that email address already exists.' : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('admin/user-form', await userFormLocals({
      user, values: { ...req.body, role_ids: v.list(req.body.role_ids).map(Number) }, error: message
    }));
  }
});

const toggleUser = action(async (req) => {
  const id = paramId(req);
  const user = await User.findById(id);
  if (!user) throw notFound();
  if (id === req.user.id) v.fail('You cannot deactivate your own account.');
  const status = user.status === 'Active' ? 'Inactive' : 'Active';
  await pool().execute('UPDATE users SET status = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?', [status, id]);
  if (status !== 'Active') await destroyUserSessions(id);
  await audit.log(null, req, {
    action: status === 'Active' ? 'activate' : 'deactivate', module: 'Users', recordId: id,
    description: `${status === 'Active' ? (user.status === 'Pending' ? 'Approved registration of' : 'Activated') : 'Deactivated'} user ${user.full_name}.`
  });
  return { status };
}, { success: (result) => `User ${result.status === 'Active' ? 'activated' : 'deactivated'}.`, redirect: '/admin/users' });

const resetPassword = action(async (req) => {
  const id = paramId(req);
  const user = await User.findById(id);
  if (!user) throw notFound();
  const strength = validatePasswordStrength(req.body.password);
  if (strength) v.fail(strength);
  await pool().execute(
    'UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?',
    [await hashPassword(req.body.password), id]
  );
  await destroyUserSessions(id);
  await audit.log(null, req, {
    action: 'password_reset', module: 'Users', recordId: id, description: `Reset the password for ${user.full_name}.`
  });
  await notifications.notifyUser(null, id, {
    type: 'account', title: 'Your password was reset',
    message: `${req.user.fullName} reset your password. Choose a new one at your next sign-in.`, link: '/account/password'
  });
}, { success: 'Password reset. The user must choose a new password at next sign-in.', redirect: (req) => `/admin/users/${req.params.id}/edit` });

/* ---------------- Roles ---------------- */

const roles = handle(async (req, res) => {
  res.render('admin/roles', { roles: await Role.list() });
});

function groupPermissions(permissions) {
  const groups = new Map();
  for (const permission of permissions) {
    if (!groups.has(permission.module)) groups.set(permission.module, []);
    groups.get(permission.module).push(permission);
  }
  return [...groups.entries()];
}

const newRole = handle(async (req, res) => {
  res.render('admin/role-form', {
    role: null, values: { is_active: 1, permission_ids: [] }, groups: groupPermissions(await Role.permissions()), error: null
  });
});

function validateRole(body) {
  return {
    name: v.text(body.name, 'Role name', { max: 100 }),
    description: v.optionalText(body.description, 'Description', 500),
    is_active: body.is_active === '0' ? 0 : 1,
    permission_ids: [...new Set(v.list(body.permission_ids).map((id) => v.id(id, 'Permission')))]
  };
}

async function setPermissions(connection, roleId, permissionIds) {
  await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  if (!permissionIds.length) return;
  const [valid] = await connection.query('SELECT id FROM permissions WHERE id IN (?)', [permissionIds]);
  if (valid.length !== permissionIds.length) v.fail('One of the selected permissions does not exist.');
  for (const permissionId of permissionIds) {
    await connection.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, permissionId]);
  }
}

async function notifyRoleMembers(connection, roleId, message) {
  const [members] = await connection.execute('SELECT user_id FROM user_roles WHERE role_id = ?', [roleId]);
  for (const member of members) {
    await notifications.notifyUser(connection, member.user_id, { type: 'account', title: 'Your role permissions changed', message, link: '/' });
  }
}

const createRole = handle(async (req, res) => {
  try {
    const values = validateRole(req.body);
    const roleKey = `${values.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'role'}_${Date.now().toString(36)}`;
    await withTransaction(async (connection) => {
      const [result] = await connection.execute(
        'INSERT INTO roles (role_key, name, description, is_active) VALUES (?, ?, ?, ?)',
        [roleKey, values.name, values.description, values.is_active]
      );
      await setPermissions(connection, result.insertId, values.permission_ids);
      await audit.log(connection, req, {
        action: 'create', module: 'Roles', recordId: result.insertId,
        description: `Created role ${values.name} with ${values.permission_ids.length} permission(s).`
      });
    });
    await req.flash('success', 'Role created.');
    res.redirect('/admin/roles');
  } catch (error) {
    const message = isDuplicateError(error) ? 'A role with that name already exists.' : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('admin/role-form', {
      role: null, values: { ...req.body, permission_ids: v.list(req.body.permission_ids).map(Number) },
      groups: groupPermissions(await Role.permissions()), error: message
    });
  }
});

const editRole = handle(async (req, res) => {
  const role = await Role.findById(paramId(req));
  if (!role) throw notFound();
  res.render('admin/role-form', {
    role, values: { ...role, permission_ids: role.permissionIds }, groups: groupPermissions(await Role.permissions()), error: null
  });
});

const updateRole = handle(async (req, res) => {
  const id = paramId(req);
  const role = await Role.findById(id);
  if (!role) throw notFound();
  try {
    const values = validateRole(req.body);
    if (role.role_key === 'super_admin') {
      if (!values.is_active) v.fail('The Super Admin role cannot be deactivated.');
      const all = await Role.permissions();
      values.permission_ids = all.map((p) => Number(p.id)); // Super Admin always keeps every permission.
    }
    if (!values.is_active && req.user.roles.some((r) => Number(r.id) === id)) {
      v.fail('You cannot deactivate a role assigned to your own account.');
    }
    await withTransaction(async (connection) => {
      await connection.execute('UPDATE roles SET name = ?, description = ?, is_active = ? WHERE id = ?',
        [values.name, values.description, values.is_active, id]);
      await setPermissions(connection, id, values.permission_ids);
      const added = values.permission_ids.filter((p) => !role.permissionIds.includes(p)).length;
      const removed = role.permissionIds.filter((p) => !values.permission_ids.includes(p)).length;
      await audit.log(connection, req, {
        action: 'update', module: 'Roles', recordId: id,
        description: `Updated role ${values.name}: ${added} permission(s) added, ${removed} removed, ${values.is_active ? 'active' : 'inactive'}.`
      });
      if (added || removed || values.is_active !== Number(role.is_active)) {
        await notifyRoleMembers(connection, id, `${req.user.fullName} updated the "${values.name}" role.`);
      }
    });
    await req.flash('success', 'Role updated.');
    res.redirect('/admin/roles');
  } catch (error) {
    const message = isDuplicateError(error) ? 'A role with that name already exists.' : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('admin/role-form', {
      role, values: { ...req.body, permission_ids: v.list(req.body.permission_ids).map(Number) },
      groups: groupPermissions(await Role.permissions()), error: message
    });
  }
});

const toggleRole = action(async (req) => {
  const id = paramId(req);
  const role = await Role.findById(id);
  if (!role) throw notFound();
  if (role.role_key === 'super_admin') throw forbidden('The Super Admin role cannot be deactivated.');
  const active = Number(role.is_active) ? 0 : 1;
  if (!active && req.user.roles.some((r) => Number(r.id) === id)) v.fail('You cannot deactivate a role assigned to your own account.');
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE roles SET is_active = ? WHERE id = ?', [active, id]);
    await audit.log(connection, req, {
      action: active ? 'activate' : 'deactivate', module: 'Roles', recordId: id,
      description: `${active ? 'Activated' : 'Deactivated'} role ${role.name}.`
    });
    await notifyRoleMembers(connection, id, `The "${role.name}" role was ${active ? 'activated' : 'deactivated'}.`);
  });
  return { active };
}, { success: (r) => `Role ${r.active ? 'activated' : 'deactivated'}.`, redirect: '/admin/roles' });

/* ---------------- Settings & departments ---------------- */

const settingsPage = handle(async (req, res) => {
  res.render('settings/index', { settings: await settings.all(), departments: await Department.list(), roles: await Role.list() });
});

const updateSettings = action(async (req) => {
  const current = await settings.all();
  const changes = [];
  await withTransaction(async (connection) => {
    for (const row of current) {
      if (!(row.setting_key in req.body)) continue;
      const value = String(req.body[row.setting_key]).trim();
      const validator = settings.validators[row.setting_key];
      if (validator && !validator(value)) v.fail(`"${row.label}" has an invalid value.`);
      if (value !== row.setting_value) {
        await connection.execute('UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
          [value, req.user.id, row.setting_key]);
        changes.push(`${row.label}: ${row.setting_value} → ${value}`);
      }
    }
    if (changes.length) {
      await audit.log(connection, req, { action: 'update', module: 'Settings', description: `Changed settings — ${changes.join('; ')}` });
    }
  });
  settings.clearCache();
  return { count: changes.length };
}, { success: (r) => (r.count ? 'Settings saved.' : 'No settings changed.'), redirect: '/settings' });

const createDepartment = action(async (req) => {
  const code = v.text(req.body.code, 'Department code', { max: 20 }).toUpperCase();
  const name = v.text(req.body.name, 'Department name', { max: 120 });
  try {
    await pool().execute('INSERT INTO departments (code, name) VALUES (?, ?)', [code, name]);
  } catch (error) {
    if (isDuplicateError(error)) v.fail('A department with that code or name already exists.');
    throw error;
  }
  await audit.log(null, req, { action: 'create', module: 'Settings', description: `Added department ${name} (${code}).` });
}, { success: 'Department added.', redirect: '/settings#departments' });

const updateDepartment = action(async (req) => {
  const id = paramId(req);
  const department = await Department.findById(id);
  if (!department) throw notFound();
  const name = v.text(req.body.name, 'Department name', { max: 120 });
  const active = req.body.is_active === '0' ? 0 : 1;
  try {
    await pool().execute('UPDATE departments SET name = ?, is_active = ? WHERE id = ?', [name, active, id]);
  } catch (error) {
    if (isDuplicateError(error)) v.fail('A department with that name already exists.');
    throw error;
  }
  await audit.log(null, req, {
    action: 'update', module: 'Settings', recordId: `department:${id}`,
    description: `Updated department ${department.code}: ${name}, ${active ? 'active' : 'inactive'}.`
  });
}, { success: 'Department updated.', redirect: '/settings#departments' });

module.exports = {
  users, newUser, createUser, editUser, updateUser, toggleUser, resetPassword,
  roles, newRole, createRole, editRole, updateRole, toggleRole,
  settingsPage, updateSettings, createDepartment, updateDepartment
};
