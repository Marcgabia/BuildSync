const assert = require('node:assert/strict');
const { hashPassword } = require('../lib/passwords');

const testPassword = 'Test-password-123';

/** Creates an active user with the given role keys. Returns the user id. */
async function createUser(connection, { name, email, roles, department = 'OPS' }) {
  const [[dept]] = await connection.query('SELECT id FROM departments WHERE code = ?', [department]);
  const [result] = await connection.execute(
    "INSERT INTO users (full_name, email, password_hash, department_id, status) VALUES (?, ?, ?, ?, 'Active')",
    [name, email, await hashPassword(testPassword), dept.id]
  );
  for (const roleKey of roles) {
    await connection.execute(
      'INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE role_key = ?', [result.insertId, roleKey]
    );
  }
  return result.insertId;
}

/** Minimal browser-like client: keeps cookies and fills the CSRF token. */
class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrf = null;
  }

  store(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async get(path) {
    const response = await fetch(this.baseUrl + path, { headers: { Cookie: this.cookieHeader() }, redirect: 'manual' });
    this.store(response);
    const text = await response.text();
    const match = text.match(/name="_csrf" value="([a-f0-9]{64})"/);
    if (match) this.csrf = match[1];
    return { status: response.status, location: response.headers.get('location'), text, headers: response.headers };
  }

  async post(path, fields = {}) {
    if (!this.csrf) await this.get('/login');
    const body = new URLSearchParams();
    body.append('_csrf', this.csrf);
    for (const [key, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
    }
    const response = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: this.cookieHeader() },
      body,
      redirect: 'manual'
    });
    this.store(response);
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  }

  async login(email, password = testPassword) {
    await this.get('/login');
    const response = await this.post('/login', { email, password });
    assert.equal(response.status, 302, `Login failed for ${email}: ${response.text.slice(0, 200)}`);
    await this.get('/');
    return response;
  }

  /** Reads the flash message shown on the next page. */
  async flashAfter(response) {
    const page = await this.get(response.location || '/');
    const match = page.text.match(/class="alert alert-(\w+)"[^>]*>([^<]*)</);
    return match ? { type: match[1], message: match[2] } : null;
  }
}

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

module.exports = { createUser, Client, startServer, stopServer, testPassword };
