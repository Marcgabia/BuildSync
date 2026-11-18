const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);
const params = { N: 16384, r: 8, p: 1, keyLength: 64 };

/**
 * Hashes a password with scrypt (a memory-hard KDF, comparable to PHP's
 * password_hash). Format: scrypt$N$r$p$saltBase64$hashBase64
 */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, params.keyLength, {
    N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, 'base64');
  const actual = await scryptAsync(String(password), Buffer.from(saltText, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validatePasswordStrength(password) {
  const value = String(password || '');
  if (value.length < 10) return 'Passwords must be at least 10 characters long.';
  if (value.length > 200) return 'Passwords must be at most 200 characters long.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return 'Passwords must contain at least one letter and one number.';
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength };
