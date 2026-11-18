const { pool } = require('../lib/db');

const User = {
  async list({ search = '', status = 'All', roleId = 0, limit, offset = 0 } = {}) {
    const like = `%${search}%`;
    const params = [search, like, like, status, status, roleId, roleId];
    const paginate = Number.isInteger(limit);
    if (paginate) params.push(limit, offset);
    const [rows] = await pool().execute(
      `SELECT u.id, u.full_name, u.email, u.status, u.last_login_at, u.created_at, d.name AS department_name,
              (SELECT GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ', ') FROM user_roles ur
                 JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_names
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       WHERE (? = '' OR u.full_name LIKE ? OR u.email LIKE ?)
         AND (? = 'All' OR u.status = ?)
         AND (? = 0 OR EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_id = ?))
       ORDER BY u.full_name${paginate ? ' LIMIT ? OFFSET ?' : ''}`,
      params
    );
    return rows;
  },

  async count({ search = '', status = 'All', roleId = 0 } = {}) {
    const like = `%${search}%`;
    const [rows] = await pool().execute(
      `SELECT COUNT(*) AS total FROM users u
       WHERE (? = '' OR u.full_name LIKE ? OR u.email LIKE ?) AND (? = 'All' OR u.status = ?)
         AND (? = 0 OR EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_id = ?))`,
      [search, like, like, status, status, roleId, roleId]
    );
    return Number(rows[0].total);
  },

  async findById(id) {
    const [rows] = await pool().execute(
      `SELECT u.id, u.full_name, u.email, u.status, u.department_id, u.last_login_at, u.created_at,
              u.must_change_password, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`,
      [id]
    );
    if (!rows[0]) return null;
    const [roles] = await pool().execute('SELECT role_id FROM user_roles WHERE user_id = ?', [id]);
    return { ...rows[0], roleIds: roles.map((row) => Number(row.role_id)) };
  },

  async findForLogin(email) {
    const [rows] = await pool().execute('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] || null;
  },

  async total() {
    const [rows] = await pool().execute('SELECT COUNT(*) AS total FROM users');
    return Number(rows[0].total);
  }
};

const Role = {
  async list() {
    const [rows] = await pool().execute(
      `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
       FROM roles r ORDER BY r.is_system DESC, r.name`
    );
    return rows;
  },

  async active() {
    const [rows] = await pool().execute('SELECT id, name FROM roles WHERE is_active = 1 ORDER BY name');
    return rows;
  },

  async findById(id) {
    const [rows] = await pool().execute('SELECT * FROM roles WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const [permissions] = await pool().execute('SELECT permission_id FROM role_permissions WHERE role_id = ?', [id]);
    return { ...rows[0], permissionIds: permissions.map((row) => Number(row.permission_id)) };
  },

  async permissions() {
    const [rows] = await pool().execute('SELECT * FROM permissions ORDER BY module, name');
    return rows;
  }
};

const Department = {
  async list() {
    const [rows] = await pool().execute(
      `SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count
       FROM departments d ORDER BY d.name`
    );
    return rows;
  },

  async active() {
    const [rows] = await pool().execute('SELECT id, code, name FROM departments WHERE is_active = 1 ORDER BY name');
    return rows;
  },

  async findById(id) {
    const [rows] = await pool().execute('SELECT * FROM departments WHERE id = ?', [id]);
    return rows[0] || null;
  }
};

module.exports = { User, Role, Department };
