const { pool, withTransaction } = require('../lib/db');
const { handle, safeRedirectPath } = require('../lib/http');
const v = require('../lib/validate');
const { hashPassword, verifyPassword, validatePasswordStrength } = require('../lib/passwords');
const { createSession, destroySession, destroyUserSessions } = require('../middleware/session');
const { User, Department } = require('../models/user');
const audit = require('../services/audit');
const notifications = require('../services/notifications');
const settings = require('../services/settings');

const maxFailures = 5;
const lockMinutes = 15;
// Used to keep response timing similar when the email does not exist.
const dummyHashPromise = hashPassword('not-a-real-password-1');

async function renderLogin(res, locals = {}, status = 200) {
  const registration = await settings.get('self_registration');
  res.status(status).render('auth/login', {
    error: null, notice: null, email: '', next: '', registrationEnabled: registration !== 'disabled', ...locals
  });
}

const loginForm = handle(async (req, res) => {
  if (req.user) return res.redirect('/');
  if (await User.total() === 0) return res.redirect('/setup');
  await renderLogin(res, { next: safeRedirectPath(req.query.next, '') });
});

const login = handle(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body.password || '');
  const next = safeRedirectPath(req.body.next, '/');
  // Same message for unknown emails and wrong passwords so accounts cannot be discovered.
  const generic = 'The email or password is incorrect. Click "Show" to check the password — your browser may have ' +
    `filled in a different saved password. After ${maxFailures} failed attempts the account is locked for ${lockMinutes} minutes.`;
  const user = email ? await User.findForLogin(email) : null;

  if (!user) {
    await verifyPassword(password, await dummyHashPromise);
    return renderLogin(res, { error: generic, email, next }, 401);
  }
  if (user.locked_until && new Date(user.locked_until.replace(' ', 'T')) > new Date()) {
    return renderLogin(res, { error: `Too many failed attempts. Try again after ${lockMinutes} minutes.`, email, next }, 429);
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const failures = Number(user.failed_login_count) + 1;
    await pool().execute(
      `UPDATE users SET failed_login_count = ?, locked_until = IF(? >= ?, NOW() + INTERVAL ? MINUTE, NULL) WHERE id = ?`,
      [failures >= maxFailures ? 0 : failures, failures, maxFailures, lockMinutes, user.id]
    );
    await audit.log(null, { userId: user.id, ip: req.ip }, {
      action: 'login_failed', module: 'Authentication', recordId: user.id, description: `Failed sign-in attempt for ${email}.`
    });
    return renderLogin(res, { error: generic, email, next }, 401);
  }
  if (user.status === 'Pending') {
    return renderLogin(res, { error: 'Your account is awaiting administrator approval. You can sign in once it is activated.', email, next }, 403);
  }
  if (user.status !== 'Active') {
    return renderLogin(res, { error: 'This account is inactive. Contact an administrator.', email, next }, 403);
  }

  await pool().execute(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?', [user.id]
  );
  await createSession(req, res, user.id);
  await audit.log(null, { userId: user.id, ip: req.ip }, {
    action: 'login', module: 'Authentication', recordId: user.id, description: `${user.full_name} signed in.`
  });
  res.redirect(next);
});

const logout = handle(async (req, res) => {
  if (req.user) {
    await audit.log(null, req, {
      action: 'logout', module: 'Authentication', recordId: req.user.id, description: `${req.user.fullName} signed out.`
    });
  }
  await destroySession(req, res);
  res.redirect('/login');
});

/** First-run setup: only available while no user accounts exist. */
const setupForm = handle(async (req, res) => {
  if (await User.total() > 0) return res.redirect('/login');
  res.render('auth/setup', { error: null, values: {}, departments: await Department.active() });
});

const setup = handle(async (req, res) => {
  if (await User.total() > 0) return res.redirect('/login');
  const values = req.body;
  try {
    const fullName = v.text(values.full_name, 'Full name', { max: 150 });
    const email = v.email(values.email);
    const departmentId = v.id(values.department_id, 'Department');
    const strength = validatePasswordStrength(values.password);
    if (strength) v.fail(strength);
    if (values.password !== values.password_confirmation) v.fail('The passwords do not match.');
    const passwordHash = await hashPassword(values.password);
    const userId = await withTransaction(async (connection) => {
      const [[existing]] = await connection.query('SELECT COUNT(*) AS total FROM users FOR UPDATE');
      if (Number(existing.total) > 0) v.fail('Setup has already been completed.');
      const [result] = await connection.execute(
        'INSERT INTO users (full_name, email, password_hash, department_id, status) VALUES (?, ?, ?, ?, ?)',
        [fullName, email, passwordHash, departmentId, 'Active']
      );
      await connection.execute(
        "INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE role_key = 'super_admin'",
        [result.insertId]
      );
      await audit.log(connection, { userId: result.insertId, ip: req.ip }, {
        action: 'create', module: 'Users', recordId: result.insertId,
        description: `Initial Super Admin account created for ${fullName}.`
      });
      return result.insertId;
    });
    await createSession(req, res, userId);
    res.redirect('/');
  } catch (error) {
    if (!(error instanceof v.ValidationError)) throw error;
    res.status(400).render('auth/setup', { error: error.message, values, departments: await Department.active() });
  }
});

const passwordForm = handle(async (req, res) => {
  res.render('auth/password', { error: null });
});

const changePassword = handle(async (req, res) => {
  try {
    const [rows] = await pool().execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!await verifyPassword(req.body.current_password, rows[0].password_hash)) v.fail('The current password is incorrect.');
    const strength = validatePasswordStrength(req.body.password);
    if (strength) v.fail(strength);
    if (req.body.password !== req.body.password_confirmation) v.fail('The new passwords do not match.');
    if (req.body.password === req.body.current_password) v.fail('Choose a password different from the current one.');
    await pool().execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      [await hashPassword(req.body.password), req.user.id]);
    await destroyUserSessions(req.user.id, req.session.id);
    await audit.log(null, req, {
      action: 'password_change', module: 'Users', recordId: req.user.id, description: `${req.user.fullName} changed their password.`
    });
    await req.flash('success', 'Your password has been changed. Other sessions were signed out.');
    res.redirect('/');
  } catch (error) {
    if (!(error instanceof v.ValidationError)) throw error;
    res.status(400).render('auth/password', { error: error.message });
  }
});

/* ---------------- Self-service registration ---------------- */

async function registerLocals(extra = {}) {
  return { error: null, values: {}, departments: await Department.active(), mode: await settings.get('self_registration'), ...extra };
}

const registerForm = handle(async (req, res) => {
  if (req.user) return res.redirect('/');
  if (await User.total() === 0) return res.redirect('/setup');
  if (await settings.get('self_registration') === 'disabled') {
    return renderLogin(res, { error: 'Account registration is turned off. Ask an administrator to create your account.' }, 403);
  }
  res.render('auth/register', await registerLocals());
});

/**
 * Creates an account from the sign-in page. New accounts always receive the
 * configured least-privileged role (never Super Admin) and, unless registration
 * is "open", stay Pending until an administrator activates them.
 */
const register = handle(async (req, res) => {
  if (req.user) return res.redirect('/');
  if (await User.total() === 0) return res.redirect('/setup');
  const mode = await settings.get('self_registration');
  if (mode === 'disabled') {
    return renderLogin(res, { error: 'Account registration is turned off. Ask an administrator to create your account.' }, 403);
  }
  const body = req.body || {};
  try {
    const fullName = v.text(body.full_name, 'Full name', { max: 150 });
    const email = v.email(body.email);
    const departmentId = v.id(body.department_id, 'Department');
    const strength = validatePasswordStrength(body.password);
    if (strength) v.fail(strength);
    if (body.password !== body.password_confirmation) v.fail('The passwords do not match.');
    if (body.terms !== 'accepted') v.fail('Confirm that you are an employee requesting access to BuildSync.');
    const passwordHash = await hashPassword(body.password);
    const roleKey = await settings.get('self_registration_role');
    const status = mode === 'open' ? 'Active' : 'Pending';

    const userId = await withTransaction(async (connection) => {
      const [[department]] = await connection.execute('SELECT id, name FROM departments WHERE id = ? AND is_active = 1', [departmentId]);
      if (!department) v.fail('Choose an active department.');
      const [[role]] = await connection.execute(
        "SELECT id, name FROM roles WHERE role_key = ? AND is_active = 1 AND role_key <> 'super_admin'", [roleKey]
      );
      if (!role) v.fail('Registration is not configured correctly. Ask an administrator to create your account.');
      const [result] = await connection.execute(
        'INSERT INTO users (full_name, email, password_hash, department_id, status) VALUES (?, ?, ?, ?, ?)',
        [fullName, email, passwordHash, departmentId, status]
      );
      await connection.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [result.insertId, role.id]);
      await audit.log(connection, { userId: result.insertId, ip: req.ip }, {
        action: 'register', module: 'Users', recordId: result.insertId,
        description: `${fullName} <${email}> registered (${department.name}, role ${role.name}, status ${status}).`
      });
      await notifications.notifyPermission(connection, 'users.manage', {
        type: 'account',
        title: status === 'Pending' ? `New account awaiting approval: ${fullName}` : `New account registered: ${fullName}`,
        message: `${email} · ${department.name} · role ${role.name}${status === 'Pending' ? '. Review and activate the account.' : '.'}`,
        link: `/admin/users/${result.insertId}/edit`, referenceType: 'user', referenceId: result.insertId
      });
      return result.insertId;
    });

    if (status === 'Active') {
      await createSession(req, res, userId);
      return res.redirect('/');
    }
    return renderLogin(res, {
      email,
      notice: 'Your account was created. An administrator will review it; you can sign in once it is activated.'
    }, 201);
  } catch (error) {
    let message = null;
    if (error && error.code === 'ER_DUP_ENTRY') message = 'An account with this email address already exists. Sign in instead.';
    else if (error instanceof v.ValidationError) message = error.message;
    if (!message) throw error;
    const values = { full_name: body.full_name, email: body.email, department_id: body.department_id };
    res.status(400).render('auth/register', await registerLocals({ error: message, values }));
  }
});

module.exports = { loginForm, login, logout, setupForm, setup, passwordForm, changePassword, registerForm, register };
