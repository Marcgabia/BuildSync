const { createHash, randomBytes } = require('node:crypto');
const { pool } = require('../lib/db');
const settings = require('../services/settings');

const cookieName = 'buildsync_sid';
const absoluteLifetimeHours = 12;

function readCookie(header, name) {
  const pair = String(header || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : '';
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function setCookie(req, res, value, maxAgeSeconds) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie',
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

async function loadPermissions(userId) {
  const [rows] = await pool().execute(
    `SELECT DISTINCT p.permission_key
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.is_active = 1
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = ?`,
    [userId]
  );
  return new Set(rows.map((row) => row.permission_key));
}

async function loadRoles(userId) {
  const [rows] = await pool().execute(
    `SELECT r.id, r.name, r.role_key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND r.is_active = 1 ORDER BY r.name`,
    [userId]
  );
  return rows;
}

/**
 * Loads the signed-in user from a server-side session row. The cookie holds a
 * random 256-bit token; only its SHA-256 hash is stored in MySQL.
 */
async function sessionMiddleware(req, res, next) {
  try {
    req.user = null;
    req.session = { id: null, flash: null };
    const token = readCookie(req.headers.cookie, cookieName);
    if (/^[a-f0-9]{64}$/.test(token)) {
      const sessionId = hashToken(token);
      const idleMinutes = await settings.getNumber('session_idle_minutes');
      const [rows] = await pool().execute(
        `SELECT s.id, s.flash, s.user_id, u.full_name, u.email, u.status, u.department_id,
                u.must_change_password, d.name AS department_name
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE s.id = ? AND s.expires_at > NOW()
           AND s.last_seen_at > (NOW() - INTERVAL ? MINUTE)`,
        [sessionId, idleMinutes]
      );
      const row = rows[0];
      if (row && row.status === 'Active') {
        req.session.id = sessionId;
        req.user = {
          id: Number(row.user_id),
          fullName: row.full_name,
          email: row.email,
          departmentId: row.department_id,
          departmentName: row.department_name,
          mustChangePassword: Boolean(row.must_change_password),
          permissions: await loadPermissions(row.user_id),
          roles: await loadRoles(row.user_id)
        };
        if (row.flash) {
          try { req.session.flash = JSON.parse(row.flash); } catch { req.session.flash = null; }
          await pool().execute('UPDATE user_sessions SET flash = NULL, last_seen_at = NOW() WHERE id = ?', [sessionId]);
        } else {
          await pool().execute('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = ?', [sessionId]);
        }
      } else if (row || token) {
        if (row) await pool().execute('DELETE FROM user_sessions WHERE id = ?', [sessionId]);
        setCookie(req, res, '', 0);
      }
    }

    req.flash = async (type, message) => {
      if (!req.session.id) return;
      await pool().execute('UPDATE user_sessions SET flash = ? WHERE id = ?',
        [JSON.stringify({ type, message: String(message).slice(0, 500) }), req.session.id]);
    };
    req.can = (...keys) => Boolean(req.user && keys.some((key) => req.user.permissions.has(key)));
    res.locals.currentUser = req.user;
    res.locals.can = req.can;
    res.locals.flash = req.session.flash;
    next();
  } catch (error) {
    next(error);
  }
}

async function createSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  const sessionId = hashToken(token);
  await pool().execute(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, NOW() + INTERVAL ? HOUR)`,
    [sessionId, userId, String(req.ip || '').slice(0, 45),
      String(req.get('user-agent') || '').slice(0, 255), absoluteLifetimeHours]
  );
  setCookie(req, res, token, absoluteLifetimeHours * 3600);
  // Opportunistic cleanup of expired sessions.
  await pool().execute('DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL 1 DAY');
  return sessionId;
}

async function destroySession(req, res) {
  if (req.session && req.session.id) {
    await pool().execute('DELETE FROM user_sessions WHERE id = ?', [req.session.id]);
  }
  setCookie(req, res, '', 0);
}

async function destroyUserSessions(userId, exceptSessionId = null) {
  await pool().execute(
    'DELETE FROM user_sessions WHERE user_id = ? AND (? IS NULL OR id <> ?)',
    [userId, exceptSessionId, exceptSessionId]
  );
}

module.exports = { sessionMiddleware, createSession, destroySession, destroyUserSessions, cookieName };
