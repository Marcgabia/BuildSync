const { ValidationError, isValidId } = require('./validate');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function notFound(message = 'The record you are looking for does not exist.') {
  return new HttpError(404, message);
}

function forbidden(message = 'You do not have permission to perform this action.') {
  return new HttpError(403, message);
}

function conflict(message) {
  return new HttpError(409, message);
}

/** Wraps an async handler so rejected promises reach Express error handling. */
function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function paramId(req, name = 'id') {
  const value = req.params[name];
  if (!isValidId(value)) throw notFound();
  return Number(value);
}

function parsePage(value) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function paginate(total, pageValue, pageSize = 15) {
  const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
  const page = Math.min(parsePage(pageValue), totalPages);
  return { page, totalPages, total: Number(total), pageSize, offset: (page - 1) * pageSize };
}

/** Builds a query string from the current filters, dropping empty values. */
function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== 'All') search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}

function isUserError(error) {
  return error instanceof ValidationError || error instanceof HttpError;
}

function isDuplicateError(error) {
  return error && error.code === 'ER_DUP_ENTRY';
}

function isForeignKeyError(error) {
  return error && ['ER_ROW_IS_REFERENCED_2', 'ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED'].includes(error.code);
}

/** Only allow same-site relative redirects. */
function safeRedirectPath(value, fallback = '/') {
  const path = String(value || '');
  return /^\/(?!\/)[^\s\\]*$/.test(path) ? path : fallback;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // neutralize spreadsheet formula injection
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, filename, columns, rows) {
  const lines = [columns.map((column) => csvEscape(column.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(
      typeof column.value === 'function' ? column.value(row) : row[column.key]
    )).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.send(`﻿${lines.join('\r\n')}`);
}

module.exports = {
  HttpError,
  notFound,
  forbidden,
  conflict,
  handle,
  paramId,
  parsePage,
  paginate,
  queryString,
  isUserError,
  isDuplicateError,
  isForeignKeyError,
  safeRedirectPath,
  sendCsv
};
