/**
 * Small server-side validation helpers. Every helper returns a normalized value
 * or throws a ValidationError with a user-facing message.
 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function text(value, label, { required = true, max = 255 } = {}) {
  const result = String(value === undefined || value === null ? '' : value).trim();
  if (required && !result) fail(`${label} is required.`);
  if (result.length > max) fail(`${label} must be at most ${max} characters.`);
  return result;
}

function optionalText(value, label, max = 255) {
  const result = text(value, label, { required: false, max });
  return result || null;
}

function integer(value, label, { min = 0, max = 2147483647, required = true } = {}) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) {
    if (!required) return null;
    fail(`${label} is required.`);
  }
  if (!/^-?\d+$/.test(raw)) fail(`${label} must be a whole number.`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return result;
}

/** Parses a money amount into integer cents to avoid floating-point drift. */
function moneyCents(value, label, { min = 0, max = 999999999999, required = true } = {}) {
  const raw = String(value === undefined || value === null ? '' : value).trim().replace(/,/g, '');
  if (!raw) {
    if (!required) return 0;
    fail(`${label} is required.`);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) fail(`${label} must be a non-negative amount with up to 2 decimals.`);
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents) || cents < min * 100 || cents > max) fail(`${label} is outside the allowed range.`);
  return cents;
}

function percent(value, label, { min = 0, max = 100, required = true } = {}) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) {
    if (!required) return 0;
    fail(`${label} is required.`);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) fail(`${label} must be a number.`);
  const result = Number(raw);
  if (result < min || result > max) fail(`${label} must be between ${min} and ${max}.`);
  return result;
}

function date(value, label, { required = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (!required) return null;
    fail(`${label} is required.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail(`${label} must be a valid date.`);
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    fail(`${label} must be a valid date.`);
  }
  return raw;
}

function oneOf(value, label, allowed) {
  const raw = String(value || '');
  if (!allowed.includes(raw)) fail(`Choose a valid ${label.toLowerCase()}.`);
  return raw;
}

function email(value, label = 'Email address') {
  const result = text(value, label, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(`Enter a valid ${label.toLowerCase()}.`);
  return result;
}

function isValidId(value) {
  return /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function id(value, label = 'Record') {
  if (!isValidId(value)) fail(`Choose a valid ${label.toLowerCase()}.`);
  return Number(value);
}

/** Normalizes array-like form input (`field[]` or repeated `field`). */
function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function centsToAmount(cents) {
  return Math.round(cents) / 100;
}

function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

module.exports = {
  ValidationError,
  fail,
  text,
  optionalText,
  integer,
  moneyCents,
  percent,
  date,
  oneOf,
  email,
  id,
  isValidId,
  list,
  centsToAmount,
  toCents,
  today
};
