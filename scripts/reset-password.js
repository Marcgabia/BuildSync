/**
 * Account recovery from the command line (for administrators with server access).
 *
 *   npm run user:reset-password -- --email someone@example.com
 *   npm run user:list
 *
 * Prompts for the new password (or reads --password), hashes it, clears failed sign-ins and
 * any lock, activates a Pending account when --activate is given, signs out existing sessions,
 * and writes an entry to the activity log. Use this when nobody can sign in to reset a password.
 */
const readline = require('node:readline');
const database = require('../database');
const { migrate } = require('../migrations/runner');
const { hashPassword, validatePasswordStrength } = require('../lib/passwords');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

let pool;

async function listUsers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.status, u.failed_login_count AS failed, u.locked_until,
            u.last_login_at, GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ', ') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.id`
  );
  console.table(rows.map((row) => ({ ...row, locked_until: row.locked_until || '' , last_login_at: row.last_login_at || '' })));
}

async function resetPassword() {
  const email = String(argument('email') || await ask('Account email: ')).trim().toLowerCase();
  const [[user]] = await pool.execute('SELECT id, full_name, status FROM users WHERE email = ?', [email]);
  if (!user) throw new Error(`No account uses the email ${email}. Run "npm run user:list" to see all accounts.`);

  const password = argument('password') || await ask('New password (10+ characters, letters and numbers): ');
  const problem = validatePasswordStrength(password);
  if (problem) throw new Error(problem);
  const confirm = argument('password') ? password : await ask('Repeat the new password: ');
  if (confirm !== password) throw new Error('The passwords do not match.');

  const activate = process.argv.includes('--activate');
  await pool.execute(
    `UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, must_change_password = 0,
       status = IF(? AND status IN ('Pending', 'Inactive', 'Locked'), 'Active', status)
     WHERE id = ?`,
    [await hashPassword(password), activate ? 1 : 0, user.id]
  );
  await pool.execute('DELETE FROM user_sessions WHERE user_id = ?', [user.id]);
  await pool.execute(
    `INSERT INTO activity_logs (user_id, action, module, record_id, description, ip_address)
     VALUES (?, 'password_reset', 'Users', ?, ?, 'command line')`,
    [user.id, String(user.id), `Password for ${user.full_name} reset from the server command line${activate ? '; account activated' : ''}.`]
  );
  const [[after]] = await pool.execute('SELECT status FROM users WHERE id = ?', [user.id]);
  console.log(`Password updated for ${user.full_name} <${email}>. Failed attempts cleared; account status: ${after.status}.`);
  if (after.status !== 'Active') console.log('This account is not Active. Re-run with --activate to activate it.');
}

async function main() {
  pool = await database.initializeDatabase();
  await migrate({ connection: pool, logger: { log() {} } });
  if (process.argv.includes('--list')) await listUsers();
  else await resetPassword();
}

main()
  .catch((error) => {
    console.error(`Could not complete: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (pool) await pool.end();
  });
